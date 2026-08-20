from __future__ import annotations

import csv
import json
import re
import shutil
import sqlite3
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from pydantic import ValidationError

from app.archive_export.schema import (
    EXPORT_FORMAT_VERSION,
    AnimalExport,
    ArchiveMetadataExport,
    ExportCounts,
    PhotoExport,
    TaxonExport,
)
from app.archive_integrity import (
    ArchiveIntegrityError,
    FileIdentity,
    contains_link_or_junction,
    file_identity,
    hash_file_stable,
    is_link_or_junction,
    open_read_only_database,
    snapshot_database,
    validate_database_connection,
    validate_flat_filename,
)
from app.config import Settings
from app.migrations import LATEST_SCHEMA_VERSION

JSON_FILENAME = "archive-metadata.json"
CSV_FILENAME = "photos.csv"
CSV_NULL = r"\N"
CSV_COLUMNS = (
    "photo_id",
    "lifecycle_state",
    "original_filename",
    "archive_relative_original_path",
    "media_type",
    "original_size_bytes",
    "original_sha256",
    "display_title",
    "common_name",
    "breed_guess",
    "species_guess",
    "category",
    "confidence",
    "description",
    "tags",
    "status",
    "animal_id",
    "animal_identifier",
    "animal_display_name",
    "taxon_id",
    "taxon_provider",
    "taxon_external_id",
    "taxon_scientific_name",
    "taxon_common_name",
    "deleted_at",
    "created_at",
    "updated_at",
)

ProgressCallback = Callable[[int, int], None]


class ArchiveExportError(RuntimeError):
    """Base class for safe metadata-export failures."""


class ArchiveExportIntegrityError(ArchiveExportError):
    """The source archive or generated artifact was inconsistent."""


class ArchiveExportSetupError(ArchiveExportError):
    """Configuration or output setup prevented safe export."""


@dataclass(frozen=True)
class ExportResult:
    destination: Path
    json_path: Path
    csv_path: Path | None
    document: ArchiveMetadataExport
    missing_stored_identity_photos: int


@dataclass(frozen=True)
class ResolvedExportSource:
    database: Path
    image_root: Path
    original_dir: Path


@dataclass(frozen=True)
class SnapshotPhoto:
    id: int
    original_filename: str
    stored_filename: str
    display_title: str | None
    common_name: str | None
    breed_guess: str | None
    species_guess: str | None
    category: str | None
    confidence: float | None
    description: str | None
    tags: list[str]
    status: str
    animal_id: int | None
    content_sha256: str | None
    original_size_bytes: int | None
    media_type: str | None
    deleted_at: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class SnapshotData:
    schema_version: int
    photos: list[SnapshotPhoto]
    animals: list[AnimalExport]
    taxa: list[TaxonExport]


@dataclass(frozen=True)
class VerifiedOriginal:
    path: Path
    identity: FileIdentity


def _required_text(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ArchiveExportIntegrityError(f"Invalid text value for {field}")
    return value


def _optional_text(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _required_text(value, field)


def _required_id(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ArchiveExportIntegrityError(f"Invalid positive integer for {field}")
    return value


def _optional_id(value: object, field: str) -> int | None:
    if value is None:
        return None
    return _required_id(value, field)


def _optional_integer(value: object, field: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ArchiveExportIntegrityError(f"Invalid integer value for {field}")
    return value


def _optional_float(value: object, field: str) -> float | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ArchiveExportIntegrityError(f"Invalid numeric value for {field}")
    return float(value)


def _timestamp(value: object, field: str, *, optional: bool = False) -> str | None:
    if value is None:
        if optional:
            return None
        raise ArchiveExportIntegrityError(f"Missing timestamp for {field}")
    if not isinstance(value, str):
        raise ArchiveExportIntegrityError(f"Invalid timestamp for {field}")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        else:
            parsed = parsed.astimezone(UTC)
    except (OverflowError, ValueError) as exc:
        raise ArchiveExportIntegrityError(f"Invalid timestamp for {field}") from exc
    return parsed.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _tags(value: object, photo_id: int) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, str):
        raise ArchiveExportIntegrityError(f"Invalid tags for photo {photo_id}")
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ArchiveExportIntegrityError(f"Invalid tags for photo {photo_id}") from exc
    if not isinstance(parsed, list) or not all(
        isinstance(item, str) for item in parsed
    ):
        raise ArchiveExportIntegrityError(f"Invalid tags for photo {photo_id}")
    return parsed


def _resolve_source(settings: Settings) -> ResolvedExportSource:
    if settings.database_path is None:
        raise ArchiveExportSetupError("In-memory SQLite databases cannot be exported")
    configured_database = settings.database_path
    if contains_link_or_junction(configured_database):
        raise ArchiveExportSetupError(
            "Configured SQLite path traverses a link or junction"
        )
    try:
        database = configured_database.resolve(strict=True)
    except OSError as exc:
        raise ArchiveExportSetupError(
            "Configured SQLite database does not exist"
        ) from exc
    if not database.is_file() or is_link_or_junction(database):
        raise ArchiveExportSetupError(
            "Configured SQLite database is not a regular file"
        )

    if contains_link_or_junction(settings.image_dir):
        raise ArchiveExportSetupError(
            "Configured image root traverses a link or junction"
        )
    try:
        image_root = settings.image_dir.resolve(strict=True)
    except OSError as exc:
        raise ArchiveExportSetupError("Configured image root does not exist") from exc
    if not image_root.is_dir() or is_link_or_junction(image_root):
        raise ArchiveExportSetupError(
            "Configured image root is not a regular directory"
        )

    configured_original = settings.image_dirs["original"]
    if contains_link_or_junction(configured_original):
        raise ArchiveExportSetupError(
            "Configured original image directory traverses a link or junction"
        )
    try:
        original_dir = configured_original.resolve(strict=True)
    except OSError as exc:
        raise ArchiveExportSetupError(
            "Configured original image directory does not exist"
        ) from exc
    if not original_dir.is_dir() or is_link_or_junction(original_dir):
        raise ArchiveExportSetupError(
            "Configured original image directory is not a regular directory"
        )
    try:
        original_dir.relative_to(image_root)
    except ValueError as exc:
        raise ArchiveExportSetupError(
            "Configured original image directory escapes the image root"
        ) from exc
    return ResolvedExportSource(database, image_root, original_dir)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _preflight_destination(
    destination: Path, source: ResolvedExportSource, settings: Settings
) -> Path:
    raw = str(destination)
    looks_like_url = re.match(r"^[A-Za-z][A-Za-z0-9+.-]+:[\\/]", raw) is not None
    if looks_like_url or raw.startswith("\\\\"):
        raise ArchiveExportSetupError(
            "Remote and URL export destinations are not supported"
        )
    requested = destination.absolute()
    if requested.exists() or is_link_or_junction(requested):
        raise ArchiveExportSetupError("Export destination must not already exist")
    if requested.name in {"", ".", ".."}:
        raise ArchiveExportSetupError("Invalid export destination")
    if contains_link_or_junction(requested.parent):
        raise ArchiveExportSetupError("Export destination traverses a link or junction")
    try:
        parent = requested.parent.resolve(strict=True)
    except OSError as exc:
        raise ArchiveExportSetupError(
            "Export destination parent does not exist"
        ) from exc
    if not parent.is_dir() or is_link_or_junction(parent):
        raise ArchiveExportSetupError(
            "Export destination parent is not a regular directory"
        )
    resolved = parent / requested.name
    forbidden = {source.database.parent, source.image_root}
    configured_data = settings.data_dir.absolute()
    if configured_data.exists() and not contains_link_or_junction(configured_data):
        forbidden.add(configured_data.resolve())
    if any(
        _is_within(resolved, root) or _is_within(root, resolved) for root in forbidden
    ):
        raise ArchiveExportSetupError(
            "Export destination overlaps active FaunaVault storage"
        )
    return resolved


def _read_snapshot(database_path: Path) -> SnapshotData:
    connection: sqlite3.Connection | None = None
    try:
        connection = open_read_only_database(database_path)
        connection.row_factory = sqlite3.Row
        migrations = validate_database_connection(connection, LATEST_SCHEMA_VERSION)

        photo_rows = connection.execute(
            "SELECT id, original_filename, stored_filename, display_title, "
            "common_name, breed_guess, species_guess, category, confidence, "
            "description, tags, status, animal_id, content_sha256, "
            "original_size_bytes, media_type, deleted_at, created_at, updated_at "
            "FROM photo ORDER BY id"
        ).fetchall()
        photos: list[SnapshotPhoto] = []
        for row in photo_rows:
            photo_id = _required_id(row["id"], "photo.id")
            photos.append(
                SnapshotPhoto(
                    id=photo_id,
                    original_filename=_required_text(
                        row["original_filename"], f"photo {photo_id} original_filename"
                    ),
                    stored_filename=_required_text(
                        row["stored_filename"], f"photo {photo_id} stored_filename"
                    ),
                    display_title=_optional_text(
                        row["display_title"], f"photo {photo_id} display_title"
                    ),
                    common_name=_optional_text(
                        row["common_name"], f"photo {photo_id} common_name"
                    ),
                    breed_guess=_optional_text(
                        row["breed_guess"], f"photo {photo_id} breed_guess"
                    ),
                    species_guess=_optional_text(
                        row["species_guess"], f"photo {photo_id} species_guess"
                    ),
                    category=_optional_text(
                        row["category"], f"photo {photo_id} category"
                    ),
                    confidence=_optional_float(
                        row["confidence"], f"photo {photo_id} confidence"
                    ),
                    description=_optional_text(
                        row["description"], f"photo {photo_id} description"
                    ),
                    tags=_tags(row["tags"], photo_id),
                    status=_required_text(row["status"], f"photo {photo_id} status"),
                    animal_id=_optional_id(
                        row["animal_id"], f"photo {photo_id} animal_id"
                    ),
                    content_sha256=_optional_text(
                        row["content_sha256"], f"photo {photo_id} content_sha256"
                    ),
                    original_size_bytes=_optional_integer(
                        row["original_size_bytes"],
                        f"photo {photo_id} original_size_bytes",
                    ),
                    media_type=_optional_text(
                        row["media_type"], f"photo {photo_id} media_type"
                    ),
                    deleted_at=_timestamp(
                        row["deleted_at"],
                        f"photo {photo_id} deleted_at",
                        optional=True,
                    ),
                    created_at=_timestamp(
                        row["created_at"], f"photo {photo_id} created_at"
                    ),
                    updated_at=_timestamp(
                        row["updated_at"], f"photo {photo_id} updated_at"
                    ),
                )
            )

        animals = [
            AnimalExport(
                id=_required_id(row["id"], "animal.id"),
                identifier=_required_text(row["identifier"], "animal.identifier"),
                display_name=_optional_text(row["display_name"], "animal.display_name"),
                taxon_id=_optional_id(row["taxon_id"], "animal.taxon_id"),
                legacy_common_name=_optional_text(
                    row["legacy_common_name"], "animal.legacy_common_name"
                ),
                legacy_species_name=_optional_text(
                    row["legacy_species_name"], "animal.legacy_species_name"
                ),
                taxonomy_status=_required_text(
                    row["taxonomy_status"], "animal.taxonomy_status"
                ),
                taxonomy_note=_optional_text(
                    row["taxonomy_note"], "animal.taxonomy_note"
                ),
                created_at=_timestamp(row["created_at"], "animal.created_at"),
                updated_at=_timestamp(row["updated_at"], "animal.updated_at"),
            )
            for row in connection.execute(
                "SELECT id, identifier, display_name, taxon_id, legacy_common_name, "
                "legacy_species_name, taxonomy_status, taxonomy_note, created_at, "
                "updated_at FROM animal ORDER BY id"
            )
        ]
        taxa = [
            TaxonExport(
                id=_required_id(row["id"], "taxon.id"),
                provider=_required_text(row["provider"], "taxon.provider"),
                external_taxon_id=_required_text(
                    row["external_taxon_id"], "taxon.external_taxon_id"
                ),
                scientific_name=_required_text(
                    row["scientific_name"], "taxon.scientific_name"
                ),
                canonical_name=_required_text(
                    row["canonical_name"], "taxon.canonical_name"
                ),
                common_name=_optional_text(row["common_name"], "taxon.common_name"),
                rank=_required_text(row["taxonomic_rank"], "taxon.taxonomic_rank"),
                kingdom=_optional_text(row["kingdom"], "taxon.kingdom"),
                phylum=_optional_text(row["phylum"], "taxon.phylum"),
                taxonomic_class=_optional_text(
                    row["taxonomic_class"], "taxon.taxonomic_class"
                ),
                taxonomic_order=_optional_text(
                    row["taxonomic_order"], "taxon.taxonomic_order"
                ),
                family=_optional_text(row["family"], "taxon.family"),
                genus=_optional_text(row["genus"], "taxon.genus"),
                species=_optional_text(row["species"], "taxon.species"),
                synchronized_at=_timestamp(
                    row["synchronized_at"], "taxon.synchronized_at"
                ),
            )
            for row in connection.execute(
                "SELECT id, provider, external_taxon_id, scientific_name, "
                "canonical_name, common_name, taxonomic_rank, kingdom, phylum, "
                "taxonomic_class, taxonomic_order, family, genus, species, "
                "synchronized_at FROM taxon ORDER BY id"
            )
        ]
        return SnapshotData(migrations[-1], photos, animals, taxa)
    except ArchiveExportIntegrityError:
        raise
    except ArchiveIntegrityError as exc:
        raise ArchiveExportIntegrityError(str(exc)) from exc
    except (sqlite3.Error, ValidationError, ValueError) as exc:
        raise ArchiveExportIntegrityError(
            f"Could not read current archive metadata: {exc}"
        ) from exc
    finally:
        if connection is not None:
            connection.close()


def _inventory_photos(
    snapshot: SnapshotData,
    original_dir: Path,
    progress: ProgressCallback | None,
) -> tuple[list[PhotoExport], list[VerifiedOriginal], int]:
    source_paths: dict[int, Path] = {}
    folded: dict[str, int] = {}
    for photo in snapshot.photos:
        try:
            validate_flat_filename(photo.stored_filename)
        except ArchiveIntegrityError as exc:
            raise ArchiveExportIntegrityError(str(exc)) from exc
        key = photo.stored_filename.casefold()
        if key in folded:
            raise ArchiveExportIntegrityError(
                "Duplicate or case-colliding original path for photo "
                f"{photo.id} and photo {folded[key]}"
            )
        folded[key] = photo.id
        path = original_dir / photo.stored_filename
        if path.parent != original_dir:
            raise ArchiveExportIntegrityError(
                f"Unsafe original path for photo {photo.id}"
            )
        source_paths[photo.id] = path

    exported: list[PhotoExport] = []
    verified: list[VerifiedOriginal] = []
    missing_identity = 0
    total = len(snapshot.photos)
    for index, photo in enumerate(snapshot.photos, start=1):
        path = source_paths[photo.id]
        if is_link_or_junction(path) or not path.is_file():
            raise ArchiveExportIntegrityError(
                f"Original for photo {photo.id} is missing or not a regular file"
            )
        try:
            digest, size, identity = hash_file_stable(path)
        except ArchiveIntegrityError as exc:
            raise ArchiveExportIntegrityError(str(exc)) from exc
        if is_link_or_junction(path):
            raise ArchiveExportIntegrityError(
                f"Original for photo {photo.id} became a link or junction"
            )
        if photo.content_sha256 is not None and photo.content_sha256 != digest:
            raise ArchiveExportIntegrityError(
                f"Photo {photo.id} original SHA-256 disagrees with the database"
            )
        if photo.original_size_bytes is not None and photo.original_size_bytes != size:
            raise ArchiveExportIntegrityError(
                f"Photo {photo.id} original size disagrees with the database"
            )
        if photo.content_sha256 is None or photo.original_size_bytes is None:
            missing_identity += 1
        exported.append(
            PhotoExport(
                id=photo.id,
                original_filename=photo.original_filename,
                archive_relative_original_path=(
                    f"images/original/{photo.stored_filename}"
                ),
                media_type=photo.media_type,
                original_size_bytes=size,
                original_sha256=digest,
                display_title=photo.display_title,
                common_name=photo.common_name,
                breed_guess=photo.breed_guess,
                species_guess=photo.species_guess,
                category=photo.category,
                confidence=photo.confidence,
                description=photo.description,
                tags=photo.tags,
                status=photo.status,
                animal_id=photo.animal_id,
                lifecycle_state="trash" if photo.deleted_at is not None else "active",
                deleted_at=photo.deleted_at,
                created_at=photo.created_at,
                updated_at=photo.updated_at,
            )
        )
        verified.append(VerifiedOriginal(path, identity))
        if progress is not None and (index % 250 == 0 or index == total):
            progress(index, total)
    return exported, verified, missing_identity


def _build_document(
    snapshot: SnapshotData, photos: list[PhotoExport]
) -> ArchiveMetadataExport:
    active = sum(photo.lifecycle_state == "active" for photo in photos)
    return ArchiveMetadataExport(
        format_version=EXPORT_FORMAT_VERSION,
        source_database_schema_version=snapshot.schema_version,
        counts=ExportCounts(
            photos=len(photos),
            active_photos=active,
            trashed_photos=len(photos) - active,
            animals=len(snapshot.animals),
            taxa=len(snapshot.taxa),
            original_bytes=sum(photo.original_size_bytes for photo in photos),
        ),
        photos=photos,
        animals=snapshot.animals,
        taxa=snapshot.taxa,
    )


def _json_bytes(document: ArchiveMetadataExport) -> bytes:
    payload = document.model_dump(mode="json", by_alias=True)
    return (
        json.dumps(
            payload,
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


def _csv_value(value: object | None) -> str:
    if value is None:
        return CSV_NULL
    if isinstance(value, float):
        text = json.dumps(value, ensure_ascii=False, allow_nan=False)
    else:
        text = str(value)
    return f"\\{text}" if text.startswith("\\") else text


def _csv_rows(document: ArchiveMetadataExport) -> list[list[str]]:
    animals = {animal.id: animal for animal in document.animals}
    taxa = {taxon.id: taxon for taxon in document.taxa}
    rows: list[list[str]] = []
    for photo in document.photos:
        animal = animals.get(photo.animal_id) if photo.animal_id is not None else None
        taxon = (
            taxa.get(animal.taxon_id)
            if animal is not None and animal.taxon_id is not None
            else None
        )
        values = (
            photo.id,
            photo.lifecycle_state,
            photo.original_filename,
            photo.archive_relative_original_path,
            photo.media_type,
            photo.original_size_bytes,
            photo.original_sha256,
            photo.display_title,
            photo.common_name,
            photo.breed_guess,
            photo.species_guess,
            photo.category,
            photo.confidence,
            photo.description,
            json.dumps(
                photo.tags, ensure_ascii=False, separators=(",", ":"), allow_nan=False
            ),
            photo.status,
            photo.animal_id,
            None if animal is None else animal.identifier,
            None if animal is None else animal.display_name,
            None if taxon is None else taxon.id,
            None if taxon is None else taxon.provider,
            None if taxon is None else taxon.external_taxon_id,
            None if taxon is None else taxon.scientific_name,
            None if taxon is None else taxon.common_name,
            photo.deleted_at,
            photo.created_at,
            photo.updated_at,
        )
        rows.append([_csv_value(value) for value in values])
    return rows


def _write_and_validate_json(path: Path, document: ArchiveMetadataExport) -> None:
    expected = _json_bytes(document)
    with path.open("xb") as output:
        output.write(expected)
    try:
        payload = json.loads(path.read_bytes().decode("utf-8"))
        validated = ArchiveMetadataExport.model_validate(payload)
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as exc:
        raise ArchiveExportIntegrityError("Generated JSON failed validation") from exc
    if _json_bytes(validated) != expected:
        raise ArchiveExportIntegrityError(
            "Generated JSON did not round-trip deterministically"
        )


def _write_and_validate_csv(path: Path, document: ArchiveMetadataExport) -> None:
    expected_rows = _csv_rows(document)
    with path.open("x", encoding="utf-8", newline="") as output:
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        writer.writerows(expected_rows)
    with path.open(encoding="utf-8", newline="") as source:
        parsed = list(csv.reader(source))
    if not parsed or tuple(parsed[0]) != CSV_COLUMNS or parsed[1:] != expected_rows:
        raise ArchiveExportIntegrityError("Generated CSV failed validation")


def _recheck_originals(original_dir: Path, originals: list[VerifiedOriginal]) -> None:
    if (
        contains_link_or_junction(original_dir)
        or not original_dir.is_dir()
        or is_link_or_junction(original_dir)
    ):
        raise ArchiveExportIntegrityError(
            "Configured original image directory changed during export"
        )
    for original in originals:
        if is_link_or_junction(original.path) or not original.path.is_file():
            raise ArchiveExportIntegrityError(
                f"Original changed before publication: {original.path.name}"
            )
        try:
            identity = file_identity(original.path)
        except ArchiveIntegrityError as exc:
            raise ArchiveExportIntegrityError(str(exc)) from exc
        if identity != original.identity or is_link_or_junction(original.path):
            raise ArchiveExportIntegrityError(
                f"Original changed before publication: {original.path.name}"
            )


def _cleanup_staging(staging: Path) -> None:
    if not staging.exists() and not is_link_or_junction(staging):
        return
    if is_link_or_junction(staging) or not staging.is_dir():
        raise OSError("incomplete export path is no longer a regular directory")
    shutil.rmtree(staging)


def create_metadata_export(
    destination: Path,
    settings: Settings,
    *,
    include_csv: bool = False,
    progress: ProgressCallback | None = None,
    after_snapshot: Callable[[], None] | None = None,
    before_publish: Callable[[], None] | None = None,
) -> ExportResult:
    source = _resolve_source(settings)
    final_path = _preflight_destination(destination, source, settings)
    staging = final_path.parent / (
        f".{final_path.name}.faunavault-export-incomplete-{uuid4().hex}"
    )
    try:
        staging.mkdir()
    except OSError as exc:
        raise ArchiveExportSetupError(
            "Could not create incomplete export directory"
        ) from exc

    document: ArchiveMetadataExport | None = None
    missing_identity = 0
    try:
        with tempfile.TemporaryDirectory(prefix="faunavault-export-snapshot-") as temp:
            snapshot_path = Path(temp) / "faunavault.db"
            try:
                snapshot_database(source.database, snapshot_path)
            except ArchiveIntegrityError as exc:
                raise ArchiveExportIntegrityError(str(exc)) from exc
            snapshot = _read_snapshot(snapshot_path)
            if after_snapshot is not None:
                after_snapshot()
            photos, verified, missing_identity = _inventory_photos(
                snapshot, source.original_dir, progress
            )
            document = _build_document(snapshot, photos)

        _write_and_validate_json(staging / JSON_FILENAME, document)
        if include_csv:
            _write_and_validate_csv(staging / CSV_FILENAME, document)
        if before_publish is not None:
            before_publish()
        _recheck_originals(source.original_dir, verified)
        _preflight_destination(final_path, source, settings)
        staging.rename(final_path)
    except Exception as exc:
        try:
            _cleanup_staging(staging)
        except OSError as cleanup_error:
            raise ArchiveExportSetupError(
                f"{exc}; incomplete export remains at {staging}: {cleanup_error}"
            ) from exc
        if isinstance(exc, ArchiveExportError):
            raise
        if isinstance(exc, (ValidationError, ValueError, TypeError)):
            raise ArchiveExportIntegrityError(
                f"Metadata export validation failed: {exc}"
            ) from exc
        if isinstance(exc, OSError):
            raise ArchiveExportSetupError(
                f"Metadata export output failed: {exc}"
            ) from exc
        raise ArchiveExportIntegrityError(
            "Metadata export failed unexpectedly"
        ) from exc

    if document is None:
        raise ArchiveExportIntegrityError("Metadata export produced no document")
    return ExportResult(
        destination=final_path,
        json_path=final_path / JSON_FILENAME,
        csv_path=final_path / CSV_FILENAME if include_csv else None,
        document=document,
        missing_stored_identity_photos=missing_identity,
    )
