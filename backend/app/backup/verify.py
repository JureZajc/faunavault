from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

from app.backup.integrity import (
    BackupError,
    hash_file,
    inspect_database,
    is_link_or_junction,
)
from app.backup.manifest import (
    BACKUP_FORMAT_VERSION,
    DATABASE_BACKUP_PATH,
    BackupManifest,
    read_manifest,
)
from app.migrations import LATEST_SCHEMA_VERSION

SUPPORTED_SCHEMA_VERSION = LATEST_SCHEMA_VERSION


@dataclass
class VerificationResult:
    backup_path: Path
    valid: bool = False
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    manifest: BackupManifest | None = None
    total_size_bytes: int = 0


def _scan_backup_entries(
    root: Path, expected_files: set[str], result: VerificationResult
) -> None:
    expected_directories = {
        "database",
        "images",
        "images/original",
        "images/resized",
        "images/thumbs",
    }

    def visit(directory: Path) -> None:
        try:
            entries = sorted(
                os.scandir(directory), key=lambda item: item.name.casefold()
            )
        except OSError as exc:
            result.errors.append(f"Could not scan backup directory: {exc}")
            return
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(root).as_posix()
            if entry.is_symlink() or is_link_or_junction(path):
                result.errors.append(f"Symlink or junction is not allowed: {relative}")
                continue
            if entry.is_dir(follow_symlinks=False):
                if relative not in expected_directories:
                    result.warnings.append(f"Unexpected directory: {relative}")
                visit(path)
            elif entry.is_file(follow_symlinks=False):
                try:
                    result.total_size_bytes += entry.stat(follow_symlinks=False).st_size
                except OSError as exc:
                    result.errors.append(f"Could not stat {relative}: {exc}")
                if relative not in expected_files and relative != "manifest.json":
                    result.warnings.append(f"Unexpected file: {relative}")
            else:
                result.errors.append(f"Unsupported filesystem entry: {relative}")

    visit(root)


def _compare_database_to_manifest(
    root: Path, manifest: BackupManifest, result: VerificationResult
) -> None:
    database_path = root / DATABASE_BACKUP_PATH
    try:
        inventory = inspect_database(database_path, SUPPORTED_SCHEMA_VERSION)
    except BackupError as exc:
        result.errors.append(str(exc))
        return

    if manifest.database.schema_version != SUPPORTED_SCHEMA_VERSION:
        result.errors.append(
            f"Unsupported backup schema version: {manifest.database.schema_version}"
        )
    if manifest.database.applied_migrations != inventory.migrations:
        result.errors.append("Manifest migration metadata does not match the database")

    jobs = inventory.job_counts
    actual_counts = {
        "photos": len(inventory.photos),
        "active_photos": inventory.active_photos,
        "trashed_photos": inventory.trashed_photos,
        "animals": inventory.animals,
        "taxa": inventory.taxa,
        "classification_jobs": {
            "total": sum(jobs.values()),
            **jobs,
        },
        "images": {
            "original": len(inventory.photos),
            "resized": len(inventory.photos),
            "thumbs": len(inventory.photos),
        },
    }
    manifest_counts = manifest.counts.model_dump()
    for key in (
        "photos",
        "active_photos",
        "trashed_photos",
        "animals",
        "taxa",
        "classification_jobs",
        "images",
    ):
        if manifest_counts[key] != actual_counts[key]:
            result.errors.append(f"Manifest {key} counts do not match the database")

    image_entries = {
        (entry.role, entry.photo_id): entry
        for entry in manifest.files
        if entry.role != "database"
    }
    if len(image_entries) != len(manifest.files) - 1:
        result.errors.append("Manifest has duplicate image role/photo mappings")

    expected_mappings: dict[tuple[str, int], str] = {}
    for photo in inventory.photos:
        expected_mappings[("original", photo.id)] = (
            f"images/original/{photo.stored_filename}"
        )
        expected_mappings[("resized", photo.id)] = (
            f"images/resized/{photo.resized_filename}"
        )
        expected_mappings[("thumbs", photo.id)] = (
            f"images/thumbs/{photo.thumbnail_filename}"
        )
    actual_mappings = {key: entry.path for key, entry in image_entries.items()}
    if actual_mappings != expected_mappings:
        result.errors.append("Manifest image entries do not match database photo paths")

    for photo in inventory.photos:
        entry = image_entries.get(("original", photo.id))
        if entry is None:
            continue
        if photo.content_sha256 is not None and photo.content_sha256 != entry.sha256:
            result.errors.append(
                f"Photo {photo.id} original checksum disagrees with the database"
            )
        if (
            photo.original_size_bytes is not None
            and photo.original_size_bytes != entry.size_bytes
        ):
            result.errors.append(
                f"Photo {photo.id} original size disagrees with the database"
            )


def verify_backup(backup_path: Path) -> VerificationResult:
    requested = backup_path.absolute()
    result = VerificationResult(backup_path=requested)
    if is_link_or_junction(requested) or not requested.is_dir():
        result.errors.append("Backup path must be a regular directory")
        return result
    root = requested.resolve()
    result.backup_path = root
    manifest_path = root / "manifest.json"
    if is_link_or_junction(manifest_path) or not manifest_path.is_file():
        result.errors.append("Backup manifest.json is missing or unsafe")
        return result
    try:
        manifest = read_manifest(manifest_path)
    except (OSError, json.JSONDecodeError, ValidationError, ValueError) as exc:
        result.errors.append(f"Invalid backup manifest: {exc}")
        return result
    result.manifest = manifest
    if manifest.backup_format_version != BACKUP_FORMAT_VERSION:
        result.errors.append(
            f"Unsupported backup format version: {manifest.backup_format_version}"
        )
        return result

    expected_files = {entry.path for entry in manifest.files}
    _scan_backup_entries(root, expected_files, result)
    for entry in manifest.files:
        path = root.joinpath(*entry.path.split("/"))
        if is_link_or_junction(path) or not path.is_file():
            result.errors.append(f"Missing or unsafe payload file: {entry.path}")
            continue
        try:
            digest, size = hash_file(path)
        except BackupError as exc:
            result.errors.append(str(exc))
            continue
        if size != entry.size_bytes:
            result.errors.append(f"Payload size mismatch: {entry.path}")
        if digest != entry.sha256:
            result.errors.append(f"Payload checksum mismatch: {entry.path}")

    database_entries = [entry for entry in manifest.files if entry.role == "database"]
    if len(database_entries) != 1:
        result.errors.append("Manifest must contain exactly one database entry")
    else:
        _compare_database_to_manifest(root, manifest, result)

    for warning in manifest.source_warnings:
        location = f" ({warning.path})" if warning.path else ""
        result.warnings.append(f"{warning.code}: {warning.message}{location}")
    result.valid = not result.errors
    return result
