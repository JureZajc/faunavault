from __future__ import annotations

import hashlib
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from app.backup.manifest import SourceWarning

CHUNK_SIZE = 1024 * 1024
JOB_STATUSES = ("queued", "running", "succeeded", "failed")


class BackupError(RuntimeError):
    """A safe, user-facing backup validation failure."""


@dataclass(frozen=True)
class PhotoRecord:
    id: int
    stored_filename: str
    resized_filename: str
    thumbnail_filename: str
    deleted: bool
    content_sha256: str | None
    original_size_bytes: int | None

    def signature(self) -> tuple[object, ...]:
        return (
            self.id,
            self.stored_filename,
            self.resized_filename,
            self.thumbnail_filename,
            self.deleted,
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


def is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def _sqlite_uri(path: Path) -> str:
    return f"file:{quote(path.as_posix(), safe='/:')}?mode=ro"


def open_read_only_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(_sqlite_uri(path), uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def snapshot_database(source_path: Path, destination_path: Path) -> None:
    source = open_read_only_database(source_path)
    destination = sqlite3.connect(destination_path)
    try:
        source.backup(destination)
    except sqlite3.DatabaseError as exc:
        raise BackupError(f"Could not create SQLite snapshot: {exc}") from exc
    finally:
        destination.close()
        source.close()


def inspect_database(path: Path, supported_schema_version: int) -> DatabaseInventory:
    try:
        connection = open_read_only_database(path)
    except sqlite3.Error as exc:
        raise BackupError(f"Could not open SQLite database: {exc}") from exc
    try:
        integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        if integrity != ["ok"]:
            raise BackupError("SQLite integrity_check failed: " + "; ".join(integrity))
        violations = list(connection.execute("PRAGMA foreign_key_check"))
        if violations:
            raise BackupError(
                f"SQLite foreign_key_check found {len(violations)} violation(s)"
            )
        migrations = [
            int(row[0])
            for row in connection.execute(
                "SELECT version FROM schema_migration ORDER BY version"
            )
        ]
        expected = list(range(1, supported_schema_version + 1))
        if migrations != expected:
            raise BackupError(
                "Unsupported schema migration state: "
                f"expected {expected}, found {migrations}"
            )
        photos = [
            PhotoRecord(
                id=int(row[0]),
                stored_filename=str(row[1]),
                resized_filename=str(row[2]),
                thumbnail_filename=str(row[3]),
                deleted=row[4] is not None,
                content_sha256=row[5],
                original_size_bytes=row[6],
            )
            for row in connection.execute(
                "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
                "deleted_at, content_sha256, original_size_bytes FROM photo ORDER BY id"
            )
        ]
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
            animals=int(
                connection.execute("SELECT COUNT(*) FROM animal").fetchone()[0]
            ),
            taxa=int(connection.execute("SELECT COUNT(*) FROM taxon").fetchone()[0]),
            job_counts=job_counts,
        )
    except sqlite3.Error as exc:
        raise BackupError(f"Could not validate SQLite database: {exc}") from exc
    finally:
        connection.close()


def read_photo_signature(path: Path) -> tuple[tuple[object, ...], ...]:
    try:
        connection = open_read_only_database(path)
        rows = connection.execute(
            "SELECT id, stored_filename, resized_filename, thumbnail_filename, "
            "deleted_at FROM photo ORDER BY id"
        ).fetchall()
        return tuple(
            (int(row[0]), str(row[1]), str(row[2]), str(row[3]), row[4] is not None)
            for row in rows
        )
    except sqlite3.Error as exc:
        raise BackupError(f"Could not re-check live archive state: {exc}") from exc
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
        raise BackupError(f"Could not read payload file {path.name}: {exc}") from exc
    return digest.hexdigest(), size


def copy_and_hash_stable(source: Path, destination: Path) -> tuple[str, int]:
    if is_link_or_junction(source) or not source.is_file():
        raise BackupError(f"Required source file is not a regular file: {source.name}")
    try:
        before = source.stat()
        digest = hashlib.sha256()
        size = 0
        with source.open("rb") as input_file, destination.open("xb") as output_file:
            for chunk in iter(lambda: input_file.read(CHUNK_SIZE), b""):
                output_file.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        after = source.stat()
    except OSError as exc:
        raise BackupError(f"Could not copy source file {source.name}: {exc}") from exc
    identity_before = (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    )
    identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if identity_before != identity_after or size != after.st_size:
        raise BackupError(f"Source file changed while being copied: {source.name}")
    return digest.hexdigest(), size


def validate_flat_filename(filename: str) -> None:
    candidate = Path(filename)
    if (
        not filename
        or candidate.is_absolute()
        or candidate.name != filename
        or filename in {".", ".."}
    ):
        raise BackupError(f"Unsafe stored image path: {filename!r}")


def scan_orphans(
    directory: Path, expected: set[Path], role: str
) -> list[SourceWarning]:
    warnings: list[SourceWarning] = []

    def visit(current: Path) -> None:
        try:
            entries = sorted(
                os.scandir(current), key=lambda entry: entry.name.casefold()
            )
        except OSError as exc:
            raise BackupError(f"Could not scan {role} image directory: {exc}") from exc
        for entry in entries:
            path = Path(entry.path)
            if entry.is_symlink() or is_link_or_junction(path):
                raise BackupError(
                    f"Symlink or junction found in {role} images: {entry.name}"
                )
            if entry.is_dir(follow_symlinks=False):
                warnings.append(
                    SourceWarning(
                        code="orphan_directory",
                        message=f"Unreferenced directory excluded from {role} images",
                        path=f"images/{role}/{path.relative_to(directory).as_posix()}",
                    )
                )
                visit(path)
            elif path not in expected:
                warnings.append(
                    SourceWarning(
                        code="orphan_file",
                        message=f"Unreferenced file excluded from {role} images",
                        path=f"images/{role}/{path.relative_to(directory).as_posix()}",
                    )
                )

    visit(directory)
    return warnings
