from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from urllib.parse import quote
from uuid import UUID

CHUNK_SIZE = 1024 * 1024
JOB_STATUSES = ("queued", "running", "succeeded", "failed")
PERCEPTUAL_HASH_PATTERN = re.compile(r"[0-9a-f]{16}")


class ArchiveIntegrityError(RuntimeError):
    """A safe, user-facing archive validation failure."""


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    size: int
    modified_ns: int


@dataclass(frozen=True)
class PhotoRecord:
    id: int
    stored_filename: str
    resized_filename: str
    thumbnail_filename: str
    deleted: bool
    content_sha256: str | None
    original_size_bytes: int | None
    perceptual_hash: str | None
    media_type: str | None
    captured_at: str | None = None
    captured_at_offset_minutes: int | None = None
    camera_make: str | None = None
    camera_model: str | None = None
    lens_model: str | None = None
    image_width: int | None = None
    image_height: int | None = None
    latitude: float | None = None
    longitude: float | None = None
    extracted_captured_at: str | None = None
    extracted_captured_at_offset_minutes: int | None = None
    extracted_latitude: float | None = None
    extracted_longitude: float | None = None
    capture_metadata_overridden: bool = False
    location_metadata_overridden: bool = False
    is_favorite: bool = False
    rating: int | None = None
    culling_state: str | None = None
    import_session_id: str | None = None

    def signature(self) -> tuple[object, ...]:
        return (
            self.id,
            self.stored_filename,
            self.resized_filename,
            self.thumbnail_filename,
            self.deleted,
            self.content_sha256,
            self.original_size_bytes,
            self.media_type,
            self.perceptual_hash,
            self.captured_at,
            self.captured_at_offset_minutes,
            self.camera_make,
            self.camera_model,
            self.lens_model,
            self.image_width,
            self.image_height,
            self.latitude,
            self.longitude,
            self.extracted_captured_at,
            self.extracted_captured_at_offset_minutes,
            self.extracted_latitude,
            self.extracted_longitude,
            self.capture_metadata_overridden,
            self.location_metadata_overridden,
            self.is_favorite,
            self.rating,
            self.culling_state,
            self.import_session_id,
        )


@dataclass(frozen=True)
class DatabaseInventory:
    migrations: list[int]
    photos: list[PhotoRecord]
    animals: int
    taxa: int
    job_counts: dict[str, int]
    collections: int = 0
    collection_memberships: int = 0
    smart_collections: int = 0

    @property
    def active_photos(self) -> int:
        return sum(not photo.deleted for photo in self.photos)

    @property
    def trashed_photos(self) -> int:
        return sum(photo.deleted for photo in self.photos)

    def photo_signature(self) -> tuple[tuple[object, ...], ...]:
        return tuple(photo.signature() for photo in self.photos)


@dataclass(frozen=True)
class OrphanFinding:
    code: str
    role: str
    relative_path: str


def is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def contains_link_or_junction(path: Path) -> bool:
    candidate = path.absolute()
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current /= part
        if current.exists() and is_link_or_junction(current):
            return True
    return False


def file_identity(path: Path) -> FileIdentity:
    try:
        stat = path.stat()
    except OSError as exc:
        raise ArchiveIntegrityError(f"Could not stat file {path.name}: {exc}") from exc
    return FileIdentity(stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)


def _sqlite_uri(path: Path) -> str:
    return f"file:{quote(path.as_posix(), safe='/:')}?mode=ro"


def open_read_only_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(_sqlite_uri(path), uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def snapshot_database(source_path: Path, destination_path: Path) -> None:
    source: sqlite3.Connection | None = None
    destination: sqlite3.Connection | None = None
    try:
        source = open_read_only_database(source_path)
        destination = sqlite3.connect(destination_path)
        source.backup(destination)
    except sqlite3.Error as exc:
        raise ArchiveIntegrityError(f"Could not create SQLite snapshot: {exc}") from exc
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()


def _photo_from_row(row) -> PhotoRecord:
    return PhotoRecord(
        id=int(row[0]),
        stored_filename=str(row[1]),
        resized_filename=str(row[2]),
        thumbnail_filename=str(row[3]),
        deleted=row[4] is not None,
        content_sha256=row[5],
        original_size_bytes=row[6],
        perceptual_hash=row[7],
        media_type=row[8],
    )


def _inspect_schema_9(
    connection: sqlite3.Connection, migrations: list[int]
) -> DatabaseInventory:
    photos = [
        _photo_from_row(row)
        for row in connection.execute(
            "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
            "deleted_at, content_sha256, original_size_bytes, perceptual_hash, "
            "media_type FROM photo ORDER BY id"
        )
    ]
    malformed = [
        photo.id
        for photo in photos
        if photo.perceptual_hash is not None
        and PERCEPTUAL_HASH_PATTERN.fullmatch(photo.perceptual_hash) is None
    ]
    if malformed:
        ids = ", ".join(str(photo_id) for photo_id in malformed)
        raise ArchiveIntegrityError(f"Invalid perceptual hash for photo id(s): {ids}")
    job_counts = {
        status: int(
            connection.execute(
                "SELECT COUNT(*) FROM classification_job WHERE status = ?",
                (status,),
            ).fetchone()[0]
        )
        for status in JOB_STATUSES
    }
    return DatabaseInventory(
        migrations=migrations,
        photos=photos,
        animals=int(connection.execute("SELECT COUNT(*) FROM animal").fetchone()[0]),
        taxa=int(connection.execute("SELECT COUNT(*) FROM taxon").fetchone()[0]),
        job_counts=job_counts,
    )


def _inspect_schema_10(
    connection: sqlite3.Connection, migrations: list[int]
) -> DatabaseInventory:
    inventory = _inspect_schema_9(connection, migrations)
    return DatabaseInventory(
        migrations=inventory.migrations,
        photos=inventory.photos,
        animals=inventory.animals,
        taxa=inventory.taxa,
        job_counts=inventory.job_counts,
        collections=int(
            connection.execute("SELECT COUNT(*) FROM collection").fetchone()[0]
        ),
        collection_memberships=int(
            connection.execute("SELECT COUNT(*) FROM collection_photo").fetchone()[0]
        ),
    )


def _photo_from_schema_11_row(row) -> PhotoRecord:
    return PhotoRecord(
        id=int(row[0]),
        stored_filename=str(row[1]),
        resized_filename=str(row[2]),
        thumbnail_filename=str(row[3]),
        deleted=row[4] is not None,
        content_sha256=row[5],
        original_size_bytes=row[6],
        perceptual_hash=row[7],
        media_type=row[8],
        captured_at=row[9],
        captured_at_offset_minutes=row[10],
        camera_make=row[11],
        camera_model=row[12],
        lens_model=row[13],
        image_width=row[14],
        image_height=row[15],
        latitude=row[16],
        longitude=row[17],
    )


def _validate_capture_metadata(photos: list[PhotoRecord]) -> None:
    invalid: list[int] = []
    for photo in photos:
        dimensions_valid = (photo.image_width is None) == (
            photo.image_height is None
        ) and (
            photo.image_width is None
            or (
                photo.image_width > 0
                and photo.image_height is not None
                and photo.image_height > 0
            )
        )
        location_valid = (photo.latitude is None) == (photo.longitude is None)
        if photo.latitude is not None and photo.longitude is not None:
            location_valid = (
                math.isfinite(photo.latitude)
                and math.isfinite(photo.longitude)
                and -90 <= photo.latitude <= 90
                and -180 <= photo.longitude <= 180
            )
        offset_valid = photo.captured_at_offset_minutes is None or (
            type(photo.captured_at_offset_minutes) is int
            and photo.captured_at is not None
            and -1439 <= photo.captured_at_offset_minutes <= 1439
        )
        timestamp_valid = True
        if photo.captured_at is not None:
            try:
                timestamp_valid = (
                    re.fullmatch(
                        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?",
                        photo.captured_at,
                    )
                    is not None
                    and datetime.fromisoformat(photo.captured_at).tzinfo is None
                )
            except (TypeError, ValueError):
                timestamp_valid = False
        text_valid = all(
            value is None or len(value) <= 200
            for value in (photo.camera_make, photo.camera_model, photo.lens_model)
        )
        if not all(
            (
                dimensions_valid,
                location_valid,
                offset_valid,
                timestamp_valid,
                text_valid,
            )
        ):
            invalid.append(photo.id)
    if invalid:
        identifiers = ", ".join(str(photo_id) for photo_id in invalid)
        raise ArchiveIntegrityError(
            f"Invalid capture metadata for photo id(s): {identifiers}"
        )


def _inspect_schema_11(
    connection: sqlite3.Connection, migrations: list[int]
) -> DatabaseInventory:
    base = _inspect_schema_10(connection, migrations)
    photos = [
        _photo_from_schema_11_row(row)
        for row in connection.execute(
            "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
            "deleted_at, content_sha256, original_size_bytes, perceptual_hash, "
            "media_type, captured_at, captured_at_offset_minutes, camera_make, "
            "camera_model, lens_model, image_width, image_height, latitude, "
            "longitude FROM photo ORDER BY id"
        )
    ]
    _validate_capture_metadata(photos)
    return DatabaseInventory(
        migrations=base.migrations,
        photos=photos,
        animals=base.animals,
        taxa=base.taxa,
        job_counts=base.job_counts,
        collections=base.collections,
        collection_memberships=base.collection_memberships,
    )


def _inspect_schema_12(
    connection: sqlite3.Connection, migrations: list[int]
) -> DatabaseInventory:
    base = _inspect_schema_11(connection, migrations)
    # Check structure even when there are no Photos. Rehearsal checks preservation.
    connection.execute("SELECT reviewed_at FROM photo LIMIT 0")
    return base


def _inspect_schema_13(
    connection: sqlite3.Connection, migrations: list[int]
) -> DatabaseInventory:
    base = _inspect_schema_12(connection, migrations)
    connection.execute(
        "SELECT id, name, name_key, query_version, query_json, created_at, updated_at "
        "FROM smart_collection LIMIT 0"
    )
    return replace(
        base,
        smart_collections=int(
            connection.execute("SELECT COUNT(*) FROM smart_collection").fetchone()[0]
        ),
    )


def duplicate_state_records(connection: sqlite3.Connection):
    pairs = connection.execute(
        "SELECT left_photo_id, right_photo_id, detector, left_hash, right_hash, distance, discovered_at, dismissed_at "
        "FROM duplicate_pair ORDER BY left_photo_id, right_photo_id, detector"
    )
    scans = connection.execute(
        "SELECT detector, status, started_at, completed_at, last_successful_at, processed, skipped, pairs, probes, reason "
        "FROM duplicate_scan_state ORDER BY detector"
    )
    return pairs, scans


def duplicate_state_signature(connection: sqlite3.Connection) -> tuple[str, str]:
    signatures = []
    for rows in duplicate_state_records(connection):
        digest = hashlib.sha256()
        for row in rows:
            digest.update(
                json.dumps(tuple(row), ensure_ascii=True, separators=(",", ":")).encode(
                    "utf-8"
                )
                + b"\n"
            )
        signatures.append(digest.hexdigest())
    return tuple(signatures)


def read_duplicate_signature(path: Path) -> tuple:
    connection = open_read_only_database(path)
    try:
        return duplicate_state_signature(connection)
    finally:
        connection.close()


def _inspect_schema_14(
    connection: sqlite3.Connection, migrations: list[int]
) -> DatabaseInventory:
    base = _inspect_schema_13(connection, migrations)
    pairs, scans = duplicate_state_records(connection)
    for (
        left,
        right,
        detector,
        left_hash,
        right_hash,
        distance,
        discovered,
        dismissed,
    ) in pairs:
        if (
            left >= right
            or not detector
            or any(
                PERCEPTUAL_HASH_PATTERN.fullmatch(value or "") is None
                for value in (left_hash, right_hash)
            )
        ):
            raise ArchiveIntegrityError(
                "Invalid duplicate pair identity or fingerprint"
            )
        if (
            not 0 <= distance <= 4
            or (int(left_hash, 16) ^ int(right_hash, 16)).bit_count() != distance
        ):
            raise ArchiveIntegrityError("Invalid duplicate pair distance")
        try:
            datetime.fromisoformat(discovered)
            if dismissed is not None:
                datetime.fromisoformat(dismissed)
        except (ValueError, TypeError) as exc:
            raise ArchiveIntegrityError("Invalid duplicate review timestamp") from exc
    for (
        detector,
        status,
        started,
        completed,
        successful,
        processed,
        skipped,
        count,
        probes,
        _reason,
    ) in scans:
        if (
            not detector
            or status not in {"complete", "incomplete"}
            or min(processed, skipped, count, probes) < 0
        ):
            raise ArchiveIntegrityError("Invalid duplicate scan state")
        try:
            datetime.fromisoformat(started)
            for value in (completed, successful):
                if value is not None:
                    datetime.fromisoformat(value)
            if status == "complete" and (completed is None or successful is None):
                raise ValueError("completed scan requires timestamps")
        except (ValueError, TypeError) as exc:
            raise ArchiveIntegrityError("Invalid duplicate scan timestamp") from exc
    return base


def _photo_from_schema_15_row(row) -> PhotoRecord:
    if (
        type(row[22]) is not int
        or row[22] not in (0, 1)
        or type(row[23]) is not int
        or row[23] not in (0, 1)
    ):
        raise ArchiveIntegrityError("Invalid capture metadata override state")
    return replace(
        _photo_from_schema_11_row(row),
        extracted_captured_at=row[18],
        extracted_captured_at_offset_minutes=row[19],
        extracted_latitude=row[20],
        extracted_longitude=row[21],
        capture_metadata_overridden=bool(row[22]),
        location_metadata_overridden=bool(row[23]),
    )


def _inspect_schema_15(connection, migrations: list[int]) -> DatabaseInventory:
    base = _inspect_schema_14(connection, migrations)
    rows = connection.execute(
        "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
        "deleted_at, content_sha256, original_size_bytes, perceptual_hash, "
        "media_type, captured_at, captured_at_offset_minutes, camera_make, "
        "camera_model, lens_model, image_width, image_height, latitude, longitude, "
        "extracted_captured_at, extracted_captured_at_offset_minutes, "
        "extracted_latitude, extracted_longitude, capture_metadata_overridden, "
        "location_metadata_overridden FROM photo ORDER BY id"
    ).fetchall()
    photos = [_photo_from_schema_15_row(row) for row in rows]
    _validate_capture_metadata(
        [
            replace(
                photo,
                captured_at=photo.extracted_captured_at,
                captured_at_offset_minutes=photo.extracted_captured_at_offset_minutes,
                latitude=photo.extracted_latitude,
                longitude=photo.extracted_longitude,
            )
            for photo in photos
        ]
    )
    return replace(base, photos=photos)


def _photo_from_schema_16_row(row) -> PhotoRecord:
    if type(row[24]) is not int or row[24] not in (0, 1):
        raise ArchiveIntegrityError("Invalid Photo Favorite state")
    if row[25] is not None and (type(row[25]) is not int or not 1 <= row[25] <= 5):
        raise ArchiveIntegrityError("Invalid Photo rating")
    return replace(
        _photo_from_schema_15_row(row), is_favorite=bool(row[24]), rating=row[25]
    )


def _inspect_schema_16(connection, migrations: list[int]) -> DatabaseInventory:
    base = _inspect_schema_15(connection, migrations)
    columns = {row[1]: row for row in connection.execute("PRAGMA table_info(photo)")}
    favorite = columns.get("is_favorite")
    rating = columns.get("rating")
    missing = {"is_favorite", "rating"} - columns.keys()
    if missing:
        raise ArchiveIntegrityError(
            f"Missing Photo curation columns: {', '.join(sorted(missing))}"
        )
    if (
        favorite is None
        or favorite[2].upper() != "BOOLEAN"
        or favorite[3] != 1
        or str(favorite[4]).strip("()'\"") != "0"
        or rating is None
        or rating[2].upper() != "INTEGER"
        or rating[3] != 0
        or rating[4] is not None
    ):
        raise ArchiveIntegrityError("Invalid Photo curation column structure")
    values = connection.execute(
        "SELECT id, is_favorite, rating FROM photo ORDER BY id"
    ).fetchall()
    photos = []
    for photo, row in zip(base.photos, values, strict=True):
        if type(row[1]) is not int or row[1] not in (0, 1):
            raise ArchiveIntegrityError("Invalid Photo Favorite state")
        if row[2] is not None and (type(row[2]) is not int or not 1 <= row[2] <= 5):
            raise ArchiveIntegrityError("Invalid Photo rating")
        photos.append(replace(photo, is_favorite=bool(row[1]), rating=row[2]))
    return replace(base, photos=photos)


def _validate_culling_state(value: object) -> str | None:
    if value is not None and (
        type(value) is not str or value not in {"pick", "reject"}
    ):
        raise ArchiveIntegrityError("Invalid Photo culling state")
    return value


def _photo_from_schema_17_row(row) -> PhotoRecord:
    return replace(
        _photo_from_schema_16_row(row), culling_state=_validate_culling_state(row[26])
    )


def _inspect_schema_17(connection, migrations: list[int]) -> DatabaseInventory:
    base = _inspect_schema_16(connection, migrations)
    columns = {row[1]: row for row in connection.execute("PRAGMA table_info(photo)")}
    column = columns.get("culling_state")
    if column is None:
        raise ArchiveIntegrityError("Missing Photo culling_state column")
    if column[2].upper() != "VARCHAR" or column[3] != 0 or column[4] is not None:
        raise ArchiveIntegrityError("Invalid Photo culling_state column structure")
    values = connection.execute(
        "SELECT id, culling_state FROM photo ORDER BY id"
    ).fetchall()
    return replace(
        base,
        photos=[
            replace(photo, culling_state=_validate_culling_state(row[1]))
            for photo, row in zip(base.photos, values, strict=True)
        ],
    )


IMPORT_SESSION_COLUMNS = "id, source_kind, started_at, completed_at, label, imported_count, duplicate_count, visual_duplicate_skipped_count, unsupported_count, failed_count"


def _import_session_records(connection) -> tuple[tuple[object, ...], ...]:
    rows = tuple(
        tuple(row)
        for row in connection.execute(
            f"SELECT {IMPORT_SESSION_COLUMNS} FROM import_session ORDER BY id"
        )
    )
    for row in rows:
        try:
            if str(UUID(row[0])) != row[0]:
                raise ValueError("noncanonical ID")
            if not isinstance(row[1], str) or not 1 <= len(row[1]) <= 100:
                raise ValueError("invalid source kind")
            started = datetime.fromisoformat(row[2])
            completed = datetime.fromisoformat(row[3]) if row[3] is not None else None
            if completed is not None and completed < started:
                raise ValueError("completion precedes start")
            label = row[4]
            if label is not None and (
                not isinstance(label, str)
                or not 1 <= len(label) <= 200
                or any(
                    not character.isprintable() or character in "/\\"
                    for character in label
                )
            ):
                raise ValueError("invalid safe label")
            if type(row[5]) is not int or row[5] < 0:
                raise ValueError("invalid imported count")
            if any(
                value is not None and (type(value) is not int or value < 0)
                for value in row[6:]
            ):
                raise ValueError("invalid outcome count")
            if completed is not None and any(value is None for value in row[6:]):
                raise ValueError("completed summary is missing outcomes")
        except (ValueError, TypeError, AttributeError) as exc:
            raise ArchiveIntegrityError(
                f"Invalid Import Session metadata: {exc}"
            ) from exc
    return rows


def read_import_session_signature(path: Path) -> tuple[tuple[object, ...], ...]:
    connection = open_read_only_database(path)
    try:
        return _import_session_records(connection)
    except sqlite3.Error as exc:
        raise ArchiveIntegrityError(f"Could not read Import Sessions: {exc}") from exc
    finally:
        connection.close()


def _photo_from_schema_18_row(row) -> PhotoRecord:
    return replace(_photo_from_schema_17_row(row), import_session_id=row[27])


def _inspect_schema_18(connection, migrations: list[int]) -> DatabaseInventory:
    base = _inspect_schema_17(connection, migrations)
    columns = {row[1]: row for row in connection.execute("PRAGMA table_info(photo)")}
    column = columns.get("import_session_id")
    if (
        column is None
        or column[2].upper() != "VARCHAR"
        or column[3] != 0
        or column[4] is not None
    ):
        raise ArchiveIntegrityError("Invalid Photo import_session_id column structure")
    foreign_keys = list(connection.execute("PRAGMA foreign_key_list(photo)"))
    if not any(
        row[2:5] == ("import_session", "import_session_id", "id")
        for row in foreign_keys
    ):
        raise ArchiveIntegrityError("Missing Photo Import Session foreign key")
    indexes = list(connection.execute("PRAGMA index_list(photo)"))
    if (
        not any(row[1] == "ix_photo_import_session_id" for row in indexes)
        or list(connection.execute("PRAGMA index_info(ix_photo_import_session_id)"))[0][
            2
        ]
        != "import_session_id"
    ):
        raise ArchiveIntegrityError("Missing Photo Import Session index")
    required = {
        "id": ("VARCHAR", 1),
        "source_kind": ("VARCHAR", 1),
        "started_at": ("DATETIME", 1),
        "completed_at": ("DATETIME", 0),
        "label": ("VARCHAR", 0),
        "imported_count": ("INTEGER", 1),
        "duplicate_count": ("INTEGER", 0),
        "visual_duplicate_skipped_count": ("INTEGER", 0),
        "unsupported_count": ("INTEGER", 0),
        "failed_count": ("INTEGER", 0),
    }
    session_columns = {
        row[1]: row for row in connection.execute("PRAGMA table_info(import_session)")
    }
    if (
        any(
            name not in session_columns
            or (session_columns[name][2].upper(), session_columns[name][3]) != shape
            for name, shape in required.items()
        )
        or session_columns["id"][5] != 1
        or str(session_columns["imported_count"][4]).strip("()'\"") != "0"
        or any(
            row[4] is not None
            for name, row in session_columns.items()
            if name in required and name != "imported_count"
        )
    ):
        raise ArchiveIntegrityError("Invalid Import Session table structure")
    records = _import_session_records(connection)
    identities = {row[0] for row in records}
    values = list(
        connection.execute("SELECT id, import_session_id FROM photo ORDER BY id")
    )
    if any(row[1] is not None and row[1] not in identities for row in values):
        raise ArchiveIntegrityError("Photo references an absent Import Session")
    memberships = dict(
        connection.execute(
            "SELECT import_session_id, COUNT(*) FROM photo WHERE import_session_id IS NOT NULL GROUP BY import_session_id"
        )
    )
    if any(row[5] < memberships.get(row[0], 0) for row in records):
        raise ArchiveIntegrityError(
            "Import Session imported count is below its surviving membership"
        )
    return replace(
        base,
        photos=[
            replace(photo, import_session_id=row[1])
            for photo, row in zip(base.photos, values, strict=True)
        ],
    )


SCHEMA_INVENTORY_READERS = {
    9: _inspect_schema_9,
    10: _inspect_schema_10,
    11: _inspect_schema_11,
    12: _inspect_schema_12,
    13: _inspect_schema_13,
    14: _inspect_schema_14,
    15: _inspect_schema_15,
    16: _inspect_schema_16,
    17: _inspect_schema_17,
    18: _inspect_schema_18,
}


def validate_database_connection(
    connection: sqlite3.Connection, expected_schema_version: int
) -> list[int]:
    integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
    if integrity != ["ok"]:
        raise ArchiveIntegrityError(
            "SQLite integrity_check failed: " + "; ".join(integrity)
        )
    violations = list(connection.execute("PRAGMA foreign_key_check"))
    if violations:
        raise ArchiveIntegrityError(
            f"SQLite foreign_key_check found {len(violations)} violation(s)"
        )
    migrations = [
        int(row[0])
        for row in connection.execute(
            "SELECT version FROM schema_migration ORDER BY version"
        )
    ]
    expected = list(range(1, expected_schema_version + 1))
    if migrations != expected:
        raise ArchiveIntegrityError(
            "Unsupported schema migration state: "
            f"expected {expected}, found {migrations}"
        )
    return migrations


def inspect_database(path: Path, expected_schema_version: int) -> DatabaseInventory:
    reader = SCHEMA_INVENTORY_READERS.get(expected_schema_version)
    if reader is None:
        raise ArchiveIntegrityError(
            f"No database inventory reader for schema {expected_schema_version}"
        )
    try:
        connection = open_read_only_database(path)
    except sqlite3.Error as exc:
        raise ArchiveIntegrityError(f"Could not open SQLite database: {exc}") from exc
    try:
        migrations = validate_database_connection(connection, expected_schema_version)
        return reader(connection, migrations)
    except sqlite3.Error as exc:
        raise ArchiveIntegrityError(
            f"Could not validate SQLite database: {exc}"
        ) from exc
    finally:
        connection.close()


def read_photo_signature(path: Path) -> tuple[tuple[object, ...], ...]:
    try:
        connection = open_read_only_database(path)
        rows = connection.execute(
            "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
            "deleted_at, content_sha256, original_size_bytes, perceptual_hash, "
            "media_type, captured_at, captured_at_offset_minutes, camera_make, "
            "camera_model, lens_model, image_width, image_height, latitude, "
            "longitude, extracted_captured_at, extracted_captured_at_offset_minutes, "
            "extracted_latitude, extracted_longitude, capture_metadata_overridden, "
            "location_metadata_overridden, is_favorite, rating, culling_state, import_session_id FROM photo ORDER BY id"
        ).fetchall()
        return tuple(_photo_from_schema_18_row(row).signature() for row in rows)
    except sqlite3.Error as exc:
        raise ArchiveIntegrityError(
            f"Could not re-check live archive state: {exc}"
        ) from exc
    finally:
        if "connection" in locals():
            connection.close()


def read_photo_record(path: Path, photo_id: int) -> PhotoRecord | None:
    try:
        connection = open_read_only_database(path)
        row = connection.execute(
            "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
            "deleted_at, content_sha256, original_size_bytes, perceptual_hash, "
            "media_type, captured_at, captured_at_offset_minutes, camera_make, "
            "camera_model, lens_model, image_width, image_height, latitude, "
            "longitude, extracted_captured_at, extracted_captured_at_offset_minutes, "
            "extracted_latitude, extracted_longitude, capture_metadata_overridden, "
            "location_metadata_overridden, is_favorite, rating, culling_state, import_session_id FROM photo WHERE id = ?",
            (photo_id,),
        ).fetchone()
        return None if row is None else _photo_from_schema_18_row(row)
    except sqlite3.Error as exc:
        raise ArchiveIntegrityError(
            f"Could not re-check photo {photo_id}: {exc}"
        ) from exc
    finally:
        if "connection" in locals():
            connection.close()


def hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    try:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(CHUNK_SIZE), b""):
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise ArchiveIntegrityError(
            f"Could not read payload file {path.name}: {exc}"
        ) from exc
    return digest.hexdigest(), size


def hash_file_stable(path: Path) -> tuple[str, int, FileIdentity]:
    before = file_identity(path)
    digest, size = hash_file(path)
    after = file_identity(path)
    if before != after or size != after.size:
        raise ArchiveIntegrityError(f"File changed while being read: {path.name}")
    return digest, size, after


def copy_and_hash_stable(source: Path, destination: Path) -> tuple[str, int]:
    if is_link_or_junction(source) or not source.is_file():
        raise ArchiveIntegrityError(
            f"Required source file is not a regular file: {source.name}"
        )
    before = file_identity(source)
    digest = hashlib.sha256()
    size = 0
    try:
        with source.open("rb") as input_file, destination.open("xb") as output_file:
            for chunk in iter(lambda: input_file.read(CHUNK_SIZE), b""):
                output_file.write(chunk)
                digest.update(chunk)
                size += len(chunk)
    except OSError as exc:
        raise ArchiveIntegrityError(
            f"Could not copy source file {source.name}: {exc}"
        ) from exc
    after = file_identity(source)
    if before != after or size != after.size:
        raise ArchiveIntegrityError(
            f"Source file changed while being copied: {source.name}"
        )
    return digest.hexdigest(), size


def validate_flat_filename(filename: str) -> None:
    candidate = Path(filename)
    if (
        not filename
        or candidate.is_absolute()
        or candidate.name != filename
        or filename in {".", ".."}
    ):
        raise ArchiveIntegrityError(f"Unsafe stored image path: {filename!r}")


def scan_orphans(
    directory: Path, expected: set[Path], role: str
) -> list[OrphanFinding]:
    findings: list[OrphanFinding] = []

    def visit(current: Path) -> None:
        try:
            entries = sorted(
                os.scandir(current), key=lambda entry: entry.name.casefold()
            )
        except OSError as exc:
            raise ArchiveIntegrityError(
                f"Could not scan {role} image directory: {exc}"
            ) from exc
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(directory).as_posix()
            if entry.is_symlink() or is_link_or_junction(path):
                raise ArchiveIntegrityError(
                    f"Symlink or junction found in {role} images: {relative}"
                )
            if entry.is_dir(follow_symlinks=False):
                findings.append(OrphanFinding("orphan_directory", role, relative))
                visit(path)
            elif entry.is_file(follow_symlinks=False):
                if path not in expected:
                    findings.append(OrphanFinding("orphan_file", role, relative))
            else:
                raise ArchiveIntegrityError(
                    f"Unsupported filesystem entry in {role} images: {relative}"
                )

    visit(directory)
    return findings
