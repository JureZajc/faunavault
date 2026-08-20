from __future__ import annotations

from pathlib import Path

from app.archive_integrity import (
    ArchiveIntegrityError,
    DatabaseInventory,
    PhotoRecord,
    copy_and_hash_stable,
    hash_file,
    inspect_database,
    is_link_or_junction,
    open_read_only_database,
    read_photo_signature,
    snapshot_database,
    validate_flat_filename,
)
from app.archive_integrity import scan_orphans as scan_archive_orphans
from app.backup.manifest import SourceWarning

BackupError = ArchiveIntegrityError


def scan_orphans(
    directory: Path, expected: set[Path], role: str
) -> list[SourceWarning]:
    return [
        SourceWarning(
            code=finding.code,
            message=(
                f"Unreferenced directory excluded from {role} images"
                if finding.code == "orphan_directory"
                else f"Unreferenced file excluded from {role} images"
            ),
            path=f"images/{role}/{finding.relative_path}",
        )
        for finding in scan_archive_orphans(directory, expected, role)
    ]


__all__ = [
    "BackupError",
    "DatabaseInventory",
    "PhotoRecord",
    "copy_and_hash_stable",
    "hash_file",
    "inspect_database",
    "is_link_or_junction",
    "open_read_only_database",
    "read_photo_signature",
    "scan_orphans",
    "snapshot_database",
    "validate_flat_filename",
]
