from __future__ import annotations

import tempfile
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from uuid import uuid4

from PIL import Image, UnidentifiedImageError

from app.archive_integrity import (
    ArchiveIntegrityError,
    DatabaseInventory,
    FileIdentity,
    PhotoRecord,
    contains_link_or_junction,
    file_identity,
    hash_file,
    inspect_database,
    is_link_or_junction,
    read_photo_record,
    read_photo_signature,
    scan_orphans,
    snapshot_database,
    validate_flat_filename,
)
from app.config import Settings
from app.migrations import LATEST_SCHEMA_VERSION
from app.services.image_variants import (
    EXPECTED_FORMAT,
    EXPECTED_MEDIA_TYPE,
    RESIZED_MAX_SIZE,
    THUMBNAIL_MAX_SIZE,
    normalized_extension,
    save_variant,
)

Severity = Literal["warning", "error", "repair"]
ProgressCallback = Callable[[int, int], None]
MAINTENANCE_TEMP_PREFIX = ".faunavault-maintenance-"
SUPPORTED_EXTENSIONS = {"jpeg", "png", "webp"}
GLOBAL_BLOCKING_CODES = {
    "archive_changed",
    "database_invalid",
    "lifecycle_state",
    "storage_unsafe",
}


class MaintenanceSetupError(RuntimeError):
    """Configuration or I/O prevented maintenance from starting safely."""


@dataclass(frozen=True)
class Finding:
    severity: Severity
    code: str
    message: str
    photo_id: int | None = None
    role: str | None = None
    filename: str | None = None


@dataclass(frozen=True)
class RepairCandidate:
    photo: PhotoRecord
    role: Literal["resized", "thumbs"]
    filename: str
    original_extension: str
    target_identity: FileIdentity | None
    defect_code: str


@dataclass(frozen=True)
class ResolvedStorage:
    database: Path
    image_root: Path
    variants: dict[str, Path]


@dataclass
class HealthResult:
    findings: list[Finding] = field(default_factory=list)
    inventory: DatabaseInventory | None = None
    expected_signature: tuple[tuple[object, ...], ...] | None = None
    candidates: list[RepairCandidate] = field(default_factory=list)
    healthy_counts: dict[str, int] = field(
        default_factory=lambda: {"original": 0, "resized": 0, "thumbs": 0}
    )
    orphan_counts: dict[str, int] = field(
        default_factory=lambda: {"original": 0, "resized": 0, "thumbs": 0}
    )

    @property
    def errors(self) -> list[Finding]:
        return [finding for finding in self.findings if finding.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [finding for finding in self.findings if finding.severity == "warning"]

    @property
    def repairs(self) -> list[Finding]:
        return [finding for finding in self.findings if finding.severity == "repair"]

    @property
    def status(self) -> str:
        if self.errors:
            return "UNHEALTHY"
        if self.repairs:
            return "NEEDS_REPAIR"
        return "HEALTHY"


@dataclass
class RepairResult:
    health: HealthResult
    applied: bool
    repaired: int = 0
    failed: int = 0
    skipped_healthy: int = 0


@dataclass(frozen=True)
class ImageValidation:
    healthy: bool
    code: str | None = None
    message: str | None = None
    identity: FileIdentity | None = None


@dataclass(frozen=True)
class OriginalValidation:
    trusted: bool
    extension: str | None
    findings: list[Finding]


def resolve_storage(settings: Settings) -> ResolvedStorage:
    if settings.database_path is None:
        raise MaintenanceSetupError("In-memory SQLite databases are not supported")
    configured = settings.database_path
    if contains_link_or_junction(configured):
        raise MaintenanceSetupError(
            "Configured SQLite path traverses a link or junction"
        )
    try:
        database = configured.resolve(strict=True)
    except OSError as exc:
        raise MaintenanceSetupError(
            "Configured SQLite database does not exist"
        ) from exc
    if not database.is_file() or is_link_or_junction(database):
        raise MaintenanceSetupError("Configured SQLite database is not a regular file")

    if contains_link_or_junction(settings.image_dir):
        raise MaintenanceSetupError(
            "Configured image root traverses a link or junction"
        )
    try:
        image_root = settings.image_dir.resolve(strict=True)
    except OSError as exc:
        raise MaintenanceSetupError("Configured image root does not exist") from exc
    if not image_root.is_dir() or is_link_or_junction(image_root):
        raise MaintenanceSetupError("Configured image root is not a regular directory")

    variants: dict[str, Path] = {}
    for role, configured_directory in settings.image_dirs.items():
        if contains_link_or_junction(configured_directory):
            raise MaintenanceSetupError(
                f"Configured {role} image directory traverses a link or junction"
            )
        try:
            directory = configured_directory.resolve(strict=True)
        except OSError as exc:
            raise MaintenanceSetupError(
                f"Configured {role} image directory does not exist"
            ) from exc
        if not directory.is_dir() or is_link_or_junction(directory):
            raise MaintenanceSetupError(
                f"Configured {role} image directory is not a regular directory"
            )
        try:
            directory.relative_to(image_root)
        except ValueError as exc:
            raise MaintenanceSetupError(
                f"Configured {role} image directory escapes the image root"
            ) from exc
        variants[role] = directory
    return ResolvedStorage(database, image_root, variants)


def lifecycle_problem(settings: Settings) -> str | None:
    for label, directory in (
        ("upload staging", settings.staging_dir),
        ("purge journal", settings.purge_dir),
    ):
        if not directory.exists():
            continue
        if contains_link_or_junction(directory) or not directory.is_dir():
            return f"Unsafe {label} path"
        try:
            if next(directory.iterdir(), None) is not None:
                suffix = ""
                if directory == settings.purge_dir:
                    suffix = "; start the backend to reconcile it, stop the backend, and retry"
                return f"{label} is not empty{suffix}"
        except OSError as exc:
            return f"Could not inspect {label}: {exc}"
    return None


def _finding(
    severity: Severity,
    code: str,
    message: str,
    photo: PhotoRecord | None = None,
    role: str | None = None,
    filename: str | None = None,
) -> Finding:
    return Finding(
        severity,
        code,
        message,
        photo_id=None if photo is None else photo.id,
        role=role,
        filename=filename,
    )


def _safe_owned_path(directory: Path, filename: str) -> Path:
    validate_flat_filename(filename)
    path = directory / filename
    if path.parent != directory:
        raise ArchiveIntegrityError(f"Unsafe stored image path: {filename!r}")
    return path


def _decode_image(
    path: Path,
    expected_format: str,
    max_image_pixels: int,
    bound: tuple[int, int] | None = None,
) -> ImageValidation:
    if is_link_or_junction(path.parent):
        return ImageValidation(False, "unsafe_path", "image directory is unsafe")
    if is_link_or_junction(path):
        return ImageValidation(False, "unsafe_path", "file is a link or junction")
    if not path.exists():
        return ImageValidation(False, "missing", "file is missing")
    if not path.is_file():
        return ImageValidation(False, "unsafe_path", "path is not a regular file")
    before: FileIdentity | None = None
    try:
        before = file_identity(path)
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as probe:
                if probe.format != expected_format:
                    return ImageValidation(
                        False,
                        "wrong_format",
                        f"expected {expected_format}, found {probe.format or 'unknown'}",
                        before,
                    )
                width, height = probe.size
                if width * height > max_image_pixels:
                    return ImageValidation(
                        False, "pixel_limit", "image exceeds MAX_IMAGE_PIXELS", before
                    )
                if bound is not None and (width > bound[0] or height > bound[1]):
                    return ImageValidation(
                        False,
                        "oversized",
                        f"dimensions {width}x{height} exceed {bound[0]}x{bound[1]}",
                        before,
                    )
                probe.verify()
            with Image.open(path) as image:
                image.load()
        after = file_identity(path)
        if before != after:
            return ImageValidation(False, "changed", "file changed while being read")
        return ImageValidation(True, identity=after)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        return ImageValidation(
            False, "pixel_limit", "image exceeds MAX_IMAGE_PIXELS", before
        )
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        return ImageValidation(
            False,
            "corrupt",
            f"image could not be decoded ({type(exc).__name__})",
            before,
        )
    except ArchiveIntegrityError as exc:
        return ImageValidation(False, "changed", str(exc), before)


def _validate_original(
    photo: PhotoRecord,
    storage: ResolvedStorage,
    settings: Settings,
) -> OriginalValidation:
    findings: list[Finding] = []
    try:
        extension = normalized_extension(photo.stored_filename)
        path = _safe_owned_path(storage.variants["original"], photo.stored_filename)
    except ArchiveIntegrityError as exc:
        findings.append(
            _finding("error", "original_unsafe_path", str(exc), photo, "original")
        )
        return OriginalValidation(False, None, findings)
    if extension not in SUPPORTED_EXTENSIONS:
        findings.append(
            _finding(
                "error",
                "original_unsupported_format",
                "filename has an unsupported image extension",
                photo,
                "original",
                photo.stored_filename,
            )
        )
        return OriginalValidation(False, extension, findings)
    expected_format = EXPECTED_FORMAT[extension]
    expected_media_type = EXPECTED_MEDIA_TYPE[extension]
    if photo.media_type is None:
        findings.append(
            _finding(
                "warning",
                "original_media_type_missing",
                "stored media type is missing",
                photo,
                "original",
                photo.stored_filename,
            )
        )
    elif photo.media_type != expected_media_type:
        findings.append(
            _finding(
                "error",
                "original_media_type_mismatch",
                f"stored media type {photo.media_type!r} does not match filename",
                photo,
                "original",
                photo.stored_filename,
            )
        )
    decoded = _decode_image(path, expected_format, settings.max_image_pixels)
    if not decoded.healthy:
        findings.append(
            _finding(
                "error",
                f"original_{decoded.code}",
                decoded.message or "original validation failed",
                photo,
                "original",
                photo.stored_filename,
            )
        )
        return OriginalValidation(False, extension, findings)
    try:
        before = decoded.identity
        if is_link_or_junction(path):
            raise ArchiveIntegrityError("original became a link or junction")
        digest, size = hash_file(path)
        after = file_identity(path)
        if before != after or is_link_or_junction(path):
            raise ArchiveIntegrityError("original changed while being hashed")
    except ArchiveIntegrityError as exc:
        findings.append(
            _finding(
                "error",
                "original_changed",
                str(exc),
                photo,
                "original",
                photo.stored_filename,
            )
        )
        return OriginalValidation(False, extension, findings)
    if photo.content_sha256 is None:
        findings.append(
            _finding(
                "warning",
                "original_sha_missing",
                "stored original SHA-256 is missing",
                photo,
                "original",
                photo.stored_filename,
            )
        )
    elif digest != photo.content_sha256:
        findings.append(
            _finding(
                "error",
                "original_sha_mismatch",
                "actual SHA-256 does not match the database",
                photo,
                "original",
                photo.stored_filename,
            )
        )
    if photo.original_size_bytes is None:
        findings.append(
            _finding(
                "warning",
                "original_size_missing",
                "stored original size is missing",
                photo,
                "original",
                photo.stored_filename,
            )
        )
    elif size != photo.original_size_bytes:
        findings.append(
            _finding(
                "error",
                "original_size_mismatch",
                "actual size does not match the database",
                photo,
                "original",
                photo.stored_filename,
            )
        )
    trusted = not any(finding.severity == "error" for finding in findings)
    return OriginalValidation(trusted, extension, findings)


def _validate_derivative(
    path: Path,
    extension: str,
    bound: tuple[int, int],
    max_image_pixels: int,
) -> ImageValidation:
    return _decode_image(path, EXPECTED_FORMAT[extension], max_image_pixels, bound)


def _validate_inventory_names(
    inventory: DatabaseInventory, result: HealthResult
) -> set[int]:
    invalid: set[int] = set()
    folded: dict[tuple[str, str], int] = {}
    for photo in inventory.photos:
        names = {
            "original": photo.stored_filename,
            "resized": photo.resized_filename,
            "thumbs": photo.thumbnail_filename,
        }
        extensions: dict[str, str] = {}
        for role, filename in names.items():
            try:
                validate_flat_filename(filename)
            except ArchiveIntegrityError as exc:
                invalid.add(photo.id)
                result.findings.append(
                    _finding("error", f"{role}_unsafe_path", str(exc), photo, role)
                )
                continue
            extension = normalized_extension(filename)
            extensions[role] = extension
            key = (role, filename.casefold())
            if key in folded:
                invalid.add(folded[key])
                invalid.add(photo.id)
                result.findings.append(
                    _finding(
                        "error",
                        f"{role}_case_collision",
                        "filename duplicates or case-collides with another photo",
                        photo,
                        role,
                        filename,
                    )
                )
            else:
                folded[key] = photo.id
        if len(extensions) == 3 and len(set(extensions.values())) != 1:
            invalid.add(photo.id)
            result.findings.append(
                _finding(
                    "error",
                    "variant_format_mismatch",
                    "original and derivative filename formats do not agree",
                    photo,
                )
            )
    return invalid


def doctor(
    settings: Settings,
    *,
    progress: ProgressCallback | None = None,
    before_finish: Callable[[], None] | None = None,
) -> HealthResult:
    storage = resolve_storage(settings)
    result = HealthResult()
    lifecycle = lifecycle_problem(settings)
    if lifecycle is not None:
        result.findings.append(Finding("error", "lifecycle_state", lifecycle))
        return result

    with tempfile.TemporaryDirectory(prefix="faunavault-maintenance-") as temporary:
        snapshot = Path(temporary) / "faunavault.db"
        try:
            snapshot_database(storage.database, snapshot)
            inventory = inspect_database(snapshot, LATEST_SCHEMA_VERSION)
        except ArchiveIntegrityError as exc:
            result.findings.append(Finding("error", "database_invalid", str(exc)))
            return result
        result.inventory = inventory
        result.expected_signature = inventory.photo_signature()
        try:
            if read_photo_signature(storage.database) != result.expected_signature:
                result.findings.append(
                    Finding(
                        "error",
                        "archive_changed",
                        "live photo inventory changed after the SQLite snapshot",
                    )
                )
                return result
        except ArchiveIntegrityError as exc:
            result.findings.append(Finding("error", "archive_changed", str(exc)))
            return result

        if inventory.job_counts["running"]:
            result.findings.append(
                Finding(
                    "warning",
                    "running_classification_jobs",
                    f"{inventory.job_counts['running']} running classification job(s) found",
                )
            )
        invalid_names = _validate_inventory_names(inventory, result)
        expected_paths = {role: set() for role in storage.variants}
        total = len(inventory.photos)
        for index, photo in enumerate(inventory.photos, start=1):
            names = {
                "original": photo.stored_filename,
                "resized": photo.resized_filename,
                "thumbs": photo.thumbnail_filename,
            }
            if photo.id not in invalid_names:
                for role, filename in names.items():
                    expected_paths[role].add(storage.variants[role] / filename)

            original = _validate_original(photo, storage, settings)
            result.findings.extend(original.findings)
            if original.trusted:
                result.healthy_counts["original"] += 1
            extension = original.extension
            for role, filename, bound in (
                ("resized", photo.resized_filename, RESIZED_MAX_SIZE),
                ("thumbs", photo.thumbnail_filename, THUMBNAIL_MAX_SIZE),
            ):
                if photo.id in invalid_names or extension not in SUPPORTED_EXTENSIONS:
                    continue
                path = storage.variants[role] / filename
                validation = _validate_derivative(
                    path, extension, bound, settings.max_image_pixels
                )
                if validation.healthy:
                    result.healthy_counts[role] += 1
                    continue
                code_role = "thumbnail" if role == "thumbs" else role
                severity: Severity = (
                    "repair"
                    if original.trusted
                    and validation.code
                    in {
                        "missing",
                        "corrupt",
                        "wrong_format",
                        "oversized",
                        "pixel_limit",
                    }
                    else "error"
                )
                result.findings.append(
                    _finding(
                        severity,
                        f"{code_role}_{validation.code}",
                        validation.message or "derivative validation failed",
                        photo,
                        role,
                        filename,
                    )
                )
                if severity == "repair":
                    result.candidates.append(
                        RepairCandidate(
                            photo,
                            role,
                            filename,
                            extension,
                            validation.identity,
                            f"{code_role}_{validation.code}",
                        )
                    )
            if progress is not None and (index % 250 == 0 or index == total):
                progress(index, total)

        for role, directory in storage.variants.items():
            try:
                orphans = scan_orphans(directory, expected_paths[role], role)
            except ArchiveIntegrityError as exc:
                result.findings.append(
                    Finding("error", "storage_unsafe", str(exc), role=role)
                )
                continue
            result.orphan_counts[role] = len(orphans)
            for orphan in orphans:
                code = (
                    "maintenance_temp"
                    if Path(orphan.relative_path).name.startswith(
                        MAINTENANCE_TEMP_PREFIX
                    )
                    else orphan.code
                )
                result.findings.append(
                    Finding(
                        "warning",
                        code,
                        "unowned filesystem entry",
                        role=role,
                        filename=orphan.relative_path,
                    )
                )

        if before_finish is not None:
            before_finish()
        lifecycle = lifecycle_problem(settings)
        if lifecycle is not None:
            result.findings.append(Finding("error", "lifecycle_state", lifecycle))
        try:
            if read_photo_signature(storage.database) != result.expected_signature:
                result.findings.append(
                    Finding(
                        "error",
                        "archive_changed",
                        "live photo inventory changed during maintenance",
                    )
                )
        except ArchiveIntegrityError as exc:
            result.findings.append(Finding("error", "archive_changed", str(exc)))
    return result


def _candidate_bound(role: str) -> tuple[int, int]:
    return RESIZED_MAX_SIZE if role == "resized" else THUMBNAIL_MAX_SIZE


def repair_derived(
    settings: Settings,
    *,
    apply: bool = False,
    progress: ProgressCallback | None = None,
    replace: Callable[[Path, Path], None] | None = None,
) -> RepairResult:
    initial = doctor(settings, progress=progress)
    repair = RepairResult(initial, applied=apply)
    if not apply:
        return repair
    if any(finding.code in GLOBAL_BLOCKING_CODES for finding in initial.errors):
        repair.failed = len(initial.candidates)
        return repair
    if initial.inventory is None or initial.expected_signature is None:
        return repair
    storage = resolve_storage(settings)
    lifecycle = lifecycle_problem(settings)
    if lifecycle is not None:
        initial.findings.append(Finding("error", "lifecycle_state", lifecycle))
        repair.failed = len(initial.candidates)
        return repair
    try:
        if read_photo_signature(storage.database) != initial.expected_signature:
            initial.findings.append(
                Finding("error", "archive_changed", "archive changed before repair")
            )
            repair.failed = len(initial.candidates)
            return repair
    except ArchiveIntegrityError as exc:
        initial.findings.append(Finding("error", "archive_changed", str(exc)))
        repair.failed = len(initial.candidates)
        return repair

    replace_file = replace or (lambda source, target: source.replace(target))
    repair_failures: list[Finding] = []
    for candidate in initial.candidates:
        try:
            photo = read_photo_record(storage.database, candidate.photo.id)
        except ArchiveIntegrityError as exc:
            repair.failed += 1
            repair_failures.append(
                _finding(
                    "error",
                    "archive_changed",
                    str(exc),
                    candidate.photo,
                    candidate.role,
                    candidate.filename,
                )
            )
            continue
        if photo is None or photo.signature() != candidate.photo.signature():
            repair.failed += 1
            repair_failures.append(
                _finding(
                    "error",
                    "archive_changed",
                    "photo authority fields changed before repair",
                    candidate.photo,
                    candidate.role,
                    candidate.filename,
                )
            )
            continue
        original = _validate_original(photo, storage, settings)
        if not original.trusted:
            repair.failed += 1
            repair_failures.append(
                _finding(
                    "error",
                    "repair_original_untrusted",
                    "original no longer passes validation",
                    photo,
                    candidate.role,
                    candidate.filename,
                )
            )
            continue
        target = storage.variants[candidate.role] / candidate.filename
        current = _validate_derivative(
            target,
            candidate.original_extension,
            _candidate_bound(candidate.role),
            settings.max_image_pixels,
        )
        if current.healthy:
            repair.skipped_healthy += 1
            continue
        if current.identity != candidate.target_identity:
            repair.failed += 1
            repair_failures.append(
                _finding(
                    "error",
                    "repair_target_changed",
                    "derivative changed after the dry-run scan",
                    photo,
                    candidate.role,
                    candidate.filename,
                )
            )
            continue
        temporary = target.with_name(f"{MAINTENANCE_TEMP_PREFIX}{uuid4().hex}.tmp")
        try:
            original_path = storage.variants["original"] / photo.stored_filename
            if is_link_or_junction(original_path):
                raise ArchiveIntegrityError("original became a link or junction")
            source_before = file_identity(original_path)
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(original_path) as image:
                    image.load()
                    save_variant(
                        image,
                        temporary,
                        candidate.original_extension,
                        _candidate_bound(candidate.role),
                    )
            if file_identity(original_path) != source_before:
                raise ArchiveIntegrityError("original changed while rendering")
            generated = _validate_derivative(
                temporary,
                candidate.original_extension,
                _candidate_bound(candidate.role),
                settings.max_image_pixels,
            )
            if not generated.healthy:
                raise ArchiveIntegrityError(
                    generated.message or "generated derivative failed validation"
                )
            latest_target = _validate_derivative(
                target,
                candidate.original_extension,
                _candidate_bound(candidate.role),
                settings.max_image_pixels,
            )
            if latest_target.healthy:
                repair.skipped_healthy += 1
                continue
            if latest_target.identity != current.identity:
                raise ArchiveIntegrityError(
                    "derivative changed while replacement was being prepared"
                )
            replace_file(temporary, target)
            promoted = _validate_derivative(
                target,
                candidate.original_extension,
                _candidate_bound(candidate.role),
                settings.max_image_pixels,
            )
            if not promoted.healthy:
                raise ArchiveIntegrityError(
                    promoted.message or "promoted derivative failed validation"
                )
            repair.repaired += 1
        except (
            ArchiveIntegrityError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
            UnidentifiedImageError,
            OSError,
            ValueError,
        ) as exc:
            repair.failed += 1
            repair_failures.append(
                _finding(
                    "error",
                    "repair_failed",
                    str(exc),
                    photo,
                    candidate.role,
                    candidate.filename,
                )
            )
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass

    final = doctor(settings, progress=progress)
    final.findings.extend(repair_failures)
    repair.health = final
    return repair
