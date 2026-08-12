from __future__ import annotations

import shutil
import tempfile
from datetime import UTC, datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from uuid import uuid4

from app.backup.integrity import (
    BackupError,
    copy_and_hash_stable,
    hash_file,
    inspect_database,
    is_link_or_junction,
    read_photo_signature,
    scan_orphans,
    snapshot_database,
    validate_flat_filename,
)
from app.backup.manifest import (
    BACKUP_FORMAT_VERSION,
    DATABASE_BACKUP_PATH,
    ApplicationInfo,
    ArchiveCounts,
    BackupFile,
    BackupManifest,
    ClassificationJobCounts,
    DatabaseInfo,
    ImageCounts,
    SourceWarning,
    write_manifest,
)
from app.backup.verify import VerificationResult, verify_backup
from app.config import Settings
from app.migrations import LATEST_SCHEMA_VERSION


def _application_version() -> str:
    try:
        return version("backend")
    except PackageNotFoundError:
        return "0.1.0"


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _ensure_lifecycle_quiet(settings: Settings) -> None:
    for label, directory in (
        ("upload staging", settings.staging_dir),
        ("purge journal", settings.purge_dir),
    ):
        if not directory.exists():
            continue
        if is_link_or_junction(directory) or not directory.is_dir():
            raise BackupError(f"Unsafe {label} path")
        try:
            if next(directory.iterdir(), None) is not None:
                message = f"{label} is not empty; the backend must be stopped"
                if directory == settings.purge_dir:
                    message += (
                        ". Let normal backend startup reconcile the purge journal, "
                        "stop it, and retry"
                    )
                raise BackupError(message)
        except OSError as exc:
            raise BackupError(f"Could not inspect {label}: {exc}") from exc


def _resolve_sources(settings: Settings) -> tuple[Path, Path, dict[str, Path]]:
    if settings.database_path is None:
        raise BackupError("In-memory SQLite databases cannot be backed up")
    try:
        database = settings.database_path.resolve(strict=True)
    except OSError as exc:
        raise BackupError(f"Configured SQLite database does not exist: {exc}") from exc
    if not database.is_file() or is_link_or_junction(database):
        raise BackupError("Configured SQLite database is not a regular file")
    try:
        image_root = settings.image_dir.resolve(strict=True)
    except OSError as exc:
        raise BackupError(f"Configured image root does not exist: {exc}") from exc
    if not image_root.is_dir() or is_link_or_junction(image_root):
        raise BackupError("Configured image root is not a regular directory")
    variants: dict[str, Path] = {}
    for role, configured in settings.image_dirs.items():
        try:
            path = configured.resolve(strict=True)
        except OSError as exc:
            raise BackupError(
                f"Configured {role} image directory is missing: {exc}"
            ) from exc
        if not path.is_dir() or is_link_or_junction(configured):
            raise BackupError(f"Configured {role} image directory is unsafe")
        variants[role] = path
    return database, image_root, variants


def _validate_destination(
    destination: Path, database: Path, image_root: Path, settings: Settings
) -> Path:
    raw = str(destination)
    if "://" in raw or raw.startswith("\\\\"):
        raise BackupError("Remote and URL backup destinations are not supported")
    requested = destination.absolute()
    if is_link_or_junction(requested) or not requested.is_dir():
        raise BackupError("Backup destination must be an existing regular directory")
    resolved = requested.resolve()
    forbidden = {
        database.parent,
        image_root,
        settings.staging_dir.resolve(),
        settings.purge_dir.resolve(),
    }
    if any(_is_within(resolved, root) for root in forbidden):
        raise BackupError("Backup destination overlaps active FaunaVault storage")
    return resolved


def _source_paths(inventory, variants: dict[str, Path]) -> dict[tuple[str, int], Path]:
    paths: dict[tuple[str, int], Path] = {}
    folded: set[tuple[str, str]] = set()
    for photo in inventory.photos:
        fields = {
            "original": photo.stored_filename,
            "resized": photo.resized_filename,
            "thumbs": photo.thumbnail_filename,
        }
        for role, filename in fields.items():
            validate_flat_filename(filename)
            key = (role, filename.casefold())
            if key in folded:
                raise BackupError(
                    f"Duplicate or case-colliding {role} path: {filename}"
                )
            folded.add(key)
            paths[(role, photo.id)] = variants[role] / filename
    return paths


def create_backup(
    destination: Path,
    settings: Settings,
    *,
    before_publish=None,
) -> tuple[Path, VerificationResult]:
    database, image_root, variants = _resolve_sources(settings)
    destination_root = _validate_destination(
        destination, database, image_root, settings
    )
    _ensure_lifecycle_quiet(settings)
    now = datetime.now(UTC)
    backup_id = str(uuid4())
    stamp = now.strftime("%Y%m%dT%H%M%S.%fZ")
    final_path = destination_root / f"faunavault-backup-{stamp}-{backup_id[:8]}"
    if final_path.exists():
        raise BackupError("Generated backup destination already exists")
    temporary = Path(
        tempfile.mkdtemp(prefix=".faunavault-backup-incomplete-", dir=destination_root)
    )
    try:
        database_dir = temporary / "database"
        database_dir.mkdir()
        for role in ("original", "resized", "thumbs"):
            (temporary / "images" / role).mkdir(parents=True, exist_ok=True)
        snapshot = temporary / DATABASE_BACKUP_PATH
        snapshot_database(database, snapshot)
        inventory = inspect_database(snapshot, LATEST_SCHEMA_VERSION)
        expected_signature = inventory.photo_signature()
        source_paths = _source_paths(inventory, variants)

        warnings: list[SourceWarning] = []
        for role, directory in variants.items():
            expected = {
                path
                for (path_role, _), path in source_paths.items()
                if path_role == role
            }
            warnings.extend(scan_orphans(directory, expected, role))
        if read_photo_signature(database) != expected_signature:
            raise BackupError("Live photo inventory changed after the SQLite snapshot")

        files: list[BackupFile] = []
        database_digest, database_size = hash_file(snapshot)
        files.append(
            BackupFile(
                path=DATABASE_BACKUP_PATH,
                role="database",
                size_bytes=database_size,
                sha256=database_digest,
            )
        )
        photos_by_id = {photo.id: photo for photo in inventory.photos}
        for (role, photo_id), source in sorted(
            source_paths.items(), key=lambda item: f"{item[0][0]}/{item[1].name}"
        ):
            _ensure_lifecycle_quiet(settings)
            relative = f"images/{role}/{source.name}"
            target = temporary.joinpath(*relative.split("/"))
            digest, size = copy_and_hash_stable(source, target)
            files.append(
                BackupFile(
                    path=relative,
                    role=role,
                    size_bytes=size,
                    sha256=digest,
                    photo_id=photo_id,
                )
            )
            if role == "original":
                photo = photos_by_id[photo_id]
                if photo.content_sha256 is None:
                    warnings.append(
                        SourceWarning(
                            code="missing_original_checksum",
                            message=f"Photo {photo_id} has no stored original checksum",
                            path=relative,
                        )
                    )
                elif photo.content_sha256 != digest:
                    raise BackupError(
                        f"Photo {photo_id} original checksum disagrees with the database"
                    )
                if photo.original_size_bytes is None:
                    warnings.append(
                        SourceWarning(
                            code="missing_original_size",
                            message=f"Photo {photo_id} has no stored original size",
                            path=relative,
                        )
                    )
                elif photo.original_size_bytes != size:
                    raise BackupError(
                        f"Photo {photo_id} original size disagrees with the database"
                    )

        running_jobs = inventory.job_counts["running"]
        if running_jobs:
            warnings.append(
                SourceWarning(
                    code="running_classification_jobs",
                    message=(
                        f"{running_jobs} running classification job(s) will follow "
                        "normal startup recovery after restore"
                    ),
                )
            )
        if read_photo_signature(database) != expected_signature:
            raise BackupError("Live photo inventory changed while files were copied")
        files.sort(key=lambda item: item.path)
        jobs = inventory.job_counts
        manifest = BackupManifest(
            backup_format_version=BACKUP_FORMAT_VERSION,
            backup_id=backup_id,
            created_at_utc=now.isoformat(timespec="microseconds").replace(
                "+00:00", "Z"
            ),
            application=ApplicationInfo(version=_application_version()),
            backup_tool_version=_application_version(),
            database=DatabaseInfo(
                schema_version=LATEST_SCHEMA_VERSION,
                applied_migrations=inventory.migrations,
            ),
            included_image_variants=["original", "resized", "thumbs"],
            counts=ArchiveCounts(
                photos=len(inventory.photos),
                active_photos=inventory.active_photos,
                trashed_photos=inventory.trashed_photos,
                animals=inventory.animals,
                taxa=inventory.taxa,
                classification_jobs=ClassificationJobCounts(
                    total=sum(jobs.values()), **jobs
                ),
                images=ImageCounts(
                    original=len(inventory.photos),
                    resized=len(inventory.photos),
                    thumbs=len(inventory.photos),
                ),
                payload_files=len(files),
                payload_bytes=sum(item.size_bytes for item in files),
            ),
            files=files,
            source_warnings=warnings,
        )
        write_manifest(temporary / "manifest.json", manifest)
        verification = verify_backup(temporary)
        if not verification.valid:
            raise BackupError(
                "Completed temporary backup failed verification: "
                + "; ".join(verification.errors)
            )
        if before_publish is not None:
            before_publish()
        _ensure_lifecycle_quiet(settings)
        if read_photo_signature(database) != expected_signature:
            raise BackupError("Live photo inventory changed before publication")
        temporary.rename(final_path)
        verification.backup_path = final_path
        return final_path, verification
    except Exception as exc:
        try:
            shutil.rmtree(temporary)
        except OSError as cleanup_error:
            raise BackupError(
                f"{exc}; incomplete backup remains at {temporary}: {cleanup_error}"
            ) from exc
        raise
