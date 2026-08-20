from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

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
        )


@dataclass(frozen=True)
class DatabaseInventory:
    migrations: list[int]
    photos: list[PhotoRecord]
    animals: int
    taxa: int
    job_counts: dict[str, int]

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


SCHEMA_INVENTORY_READERS = {9: _inspect_schema_9}


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
            "media_type FROM photo ORDER BY id"
        ).fetchall()
        return tuple(_photo_from_row(row).signature() for row in rows)
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
            "media_type FROM photo WHERE id = ?",
            (photo_id,),
        ).fetchone()
        return None if row is None else _photo_from_row(row)
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
