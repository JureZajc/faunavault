from __future__ import annotations

import json
import re
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from uuid import uuid4

from sqlalchemy import Engine
from sqlmodel import Session

from app.archive_integrity import (
    ArchiveIntegrityError,
    contains_link_or_junction,
    hash_file,
    inspect_database,
    is_link_or_junction,
    open_read_only_database,
    validate_flat_filename,
)
from app.backup.integrity import copy_and_hash_stable
from app.backup.manifest import DATABASE_BACKUP_PATH, BackupManifest
from app.backup.verify import VerificationResult, verify_backup
from app.config import Settings
from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION
from app.services.albums import list_albums
from app.services.archive_maintenance import doctor
from app.services.classification_jobs import recover_interrupted_jobs
from app.storage_startup import initialize_archive_storage

Stage = str
JOB_STATUSES = ("queued", "running", "succeeded", "failed")


class RehearsalError(RuntimeError):
    def __init__(self, stage: Stage, message: str, *, exit_code: int) -> None:
        super().__init__(message)
        self.stage = stage
        self.exit_code = exit_code


class RehearsalIntegrityError(RehearsalError):
    def __init__(self, stage: Stage, message: str) -> None:
        super().__init__(stage, message, exit_code=1)


class RehearsalSetupError(RehearsalError):
    def __init__(self, stage: Stage, message: str) -> None:
        super().__init__(stage, message, exit_code=2)


@dataclass(frozen=True)
class PhotoRecoveryRecord:
    id: int
    original_filename: str
    stored_filename: str
    resized_filename: str
    thumbnail_filename: str
    display_title: str | None
    common_name: str | None
    breed_guess: str | None
    species_guess: str | None
    category: str | None
    confidence: float | None
    description: str | None
    tags: tuple[str, ...]
    status: str
    animal_id: int | None
    content_sha256: str | None
    perceptual_hash: str | None
    original_size_bytes: int | None
    media_type: str | None
    deleted: bool


@dataclass(frozen=True)
class AnimalRecoveryRecord:
    id: int
    identifier: str
    display_name: str | None
    taxon_id: int | None
    legacy_common_name: str | None
    legacy_species_name: str | None
    legacy_species_group: str
    taxonomy_status: str
    taxonomy_note: str | None


@dataclass(frozen=True)
class TaxonRecoveryRecord:
    id: int
    provider: str
    external_taxon_id: str
    scientific_name: str
    canonical_name: str
    common_name: str | None
    taxonomic_rank: str
    kingdom: str | None
    phylum: str | None
    taxonomic_class: str | None
    taxonomic_order: str | None
    family: str | None
    genus: str | None
    species: str | None


@dataclass(frozen=True)
class RecoverySnapshot:
    photos: tuple[PhotoRecoveryRecord, ...]
    animals: tuple[AnimalRecoveryRecord, ...]
    taxa: tuple[TaxonRecoveryRecord, ...]
    job_counts: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class RehearsalResult:
    backup_path: Path
    target: Path
    backup_format_version: int
    source_schema_version: int
    current_schema_version: int
    applied_migrations: tuple[int, ...]
    recovered_classification_jobs: int
    photos: int
    active_photos: int
    trashed_photos: int
    animals: int
    taxa: int
    albums: int
    doctor_status: str
    warnings: tuple[str, ...]


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _tags(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    parsed = json.loads(str(value))
    if not isinstance(parsed, list) or not all(
        isinstance(item, str) for item in parsed
    ):
        raise ArchiveIntegrityError("Photo tags are not a JSON string list")
    return tuple(parsed)


def _read_schema_9_snapshot(database_path: Path) -> RecoverySnapshot:
    connection: sqlite3.Connection | None = None
    try:
        connection = open_read_only_database(database_path)
        photos = tuple(
            PhotoRecoveryRecord(
                id=int(row[0]),
                original_filename=str(row[1]),
                stored_filename=str(row[2]),
                resized_filename=str(row[3]),
                thumbnail_filename=str(row[4]),
                display_title=row[5],
                common_name=row[6],
                breed_guess=row[7],
                species_guess=row[8],
                category=row[9],
                confidence=row[10],
                description=row[11],
                tags=_tags(row[12]),
                status=str(row[13]),
                animal_id=row[14],
                content_sha256=row[15],
                perceptual_hash=row[16],
                original_size_bytes=row[17],
                media_type=row[18],
                deleted=row[19] is not None,
            )
            for row in connection.execute(
                "SELECT id, original_filename, stored_filename, resized_filename, "
                "thumbnail_filename, display_title, common_name, breed_guess, "
                "species_guess, category, confidence, description, tags, status, "
                "animal_id, content_sha256, perceptual_hash, original_size_bytes, "
                "media_type, deleted_at FROM photo ORDER BY id"
            )
        )
        animals = tuple(
            AnimalRecoveryRecord(
                id=int(row[0]),
                identifier=str(row[1]),
                display_name=row[2],
                taxon_id=row[3],
                legacy_common_name=row[4],
                legacy_species_name=row[5],
                legacy_species_group=str(row[6]),
                taxonomy_status=str(row[7]),
                taxonomy_note=row[8],
            )
            for row in connection.execute(
                "SELECT id, identifier, display_name, taxon_id, legacy_common_name, "
                "legacy_species_name, legacy_species_group, taxonomy_status, "
                "taxonomy_note FROM animal ORDER BY id"
            )
        )
        taxa = tuple(
            TaxonRecoveryRecord(
                id=int(row[0]),
                provider=str(row[1]),
                external_taxon_id=str(row[2]),
                scientific_name=str(row[3]),
                canonical_name=str(row[4]),
                common_name=row[5],
                taxonomic_rank=str(row[6]),
                kingdom=row[7],
                phylum=row[8],
                taxonomic_class=row[9],
                taxonomic_order=row[10],
                family=row[11],
                genus=row[12],
                species=row[13],
            )
            for row in connection.execute(
                "SELECT id, provider, external_taxon_id, scientific_name, "
                "canonical_name, common_name, taxonomic_rank, kingdom, phylum, "
                "taxonomic_class, taxonomic_order, family, genus, species "
                "FROM taxon ORDER BY id"
            )
        )
        job_counts = tuple(
            (
                status,
                int(
                    connection.execute(
                        "SELECT COUNT(*) FROM classification_job WHERE status = ?",
                        (status,),
                    ).fetchone()[0]
                ),
            )
            for status in JOB_STATUSES
        )
        return RecoverySnapshot(photos, animals, taxa, job_counts)
    except ArchiveIntegrityError:
        raise
    except (sqlite3.Error, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ArchiveIntegrityError(f"Could not read recovery metadata: {exc}") from exc
    finally:
        if connection is not None:
            connection.close()


def _read_current_snapshot(database_path: Path) -> RecoverySnapshot:
    # Schema 9 is the current schema. When a future migration intentionally
    # transforms stable fields, update only this post-migration reader/comparator;
    # the frozen schema-9 source reader above must remain unchanged.
    return _read_schema_9_snapshot(database_path)


def _verify_source(backup_path: Path) -> tuple[VerificationResult, str]:
    requested = backup_path.absolute()
    if contains_link_or_junction(requested):
        raise RehearsalIntegrityError(
            "backup verification", "Backup path traverses a link or junction"
        )
    result = verify_backup(requested)
    if not result.valid or result.manifest is None:
        detail = "; ".join(result.errors) or "Backup verification failed"
        raise RehearsalIntegrityError("backup verification", detail)
    try:
        manifest_hash, _ = hash_file(result.backup_path / "manifest.json")
    except ArchiveIntegrityError as exc:
        raise RehearsalIntegrityError("backup verification", str(exc)) from exc
    return result, manifest_hash


def _preflight_target(backup_root: Path, target: Path) -> Path:
    raw = str(target)
    looks_like_url = re.match(r"^[A-Za-z][A-Za-z0-9+.-]+:[\\/]", raw) is not None
    if looks_like_url or raw.startswith("\\\\"):
        raise RehearsalSetupError(
            "target preflight", "Remote and URL rehearsal targets are not supported"
        )
    requested = target.absolute()
    if requested.exists() or is_link_or_junction(requested):
        raise RehearsalSetupError(
            "target preflight", "Rehearsal target must not already exist"
        )
    if requested.name in {"", ".", ".."}:
        raise RehearsalSetupError("target preflight", "Invalid rehearsal target")
    parent = requested.parent
    if contains_link_or_junction(parent):
        raise RehearsalSetupError(
            "target preflight", "Rehearsal target traverses a link or junction"
        )
    try:
        resolved_parent = parent.resolve(strict=True)
    except OSError as exc:
        raise RehearsalSetupError(
            "target preflight", "Rehearsal target parent does not exist"
        ) from exc
    if not resolved_parent.is_dir() or is_link_or_junction(resolved_parent):
        raise RehearsalSetupError(
            "target preflight", "Rehearsal target parent is not a regular directory"
        )
    resolved = resolved_parent / requested.name
    if _is_within(resolved, backup_root) or _is_within(backup_root, resolved):
        raise RehearsalSetupError(
            "target preflight", "Rehearsal target overlaps the source backup"
        )
    return resolved


def _isolated_settings(root: Path) -> Settings:
    database_path = root / "data" / "faunavault.db"
    return Settings(
        _env_file=None,
        data_dir=root / "data",
        image_dir=root / "images",
        database_url=f"sqlite:///{database_path.as_posix()}",
    )


def _copy_payload(
    backup_root: Path, staging: Path, manifest: BackupManifest
) -> Settings:
    settings = _isolated_settings(staging)
    (staging / "data").mkdir()
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True)
    settings.staging_dir.mkdir()
    settings.purge_dir.mkdir()

    for entry in manifest.files:
        source = backup_root.joinpath(*entry.path.split("/"))
        if contains_link_or_junction(source):
            raise ArchiveIntegrityError(
                f"Payload path traverses a link or junction: {entry.path}"
            )
        if entry.role == "database":
            if entry.path != DATABASE_BACKUP_PATH:
                raise ArchiveIntegrityError("Unexpected database payload path")
            destination = settings.database_path
        else:
            filename = PurePosixPath(entry.path).name
            validate_flat_filename(filename)
            destination = settings.image_dirs[entry.role] / filename
        if destination is None or not _is_within(destination, staging):
            raise ArchiveIntegrityError("Payload destination escapes rehearsal storage")
        digest, size = copy_and_hash_stable(source, destination)
        if digest != entry.sha256 or size != entry.size_bytes:
            raise ArchiveIntegrityError(
                f"Source changed after verification: {entry.path}"
            )
        copied_digest, copied_size = hash_file(destination)
        if copied_digest != entry.sha256 or copied_size != entry.size_bytes:
            raise ArchiveIntegrityError(
                f"Copied payload failed verification: {entry.path}"
            )
    return settings


def _compare_recovery_snapshots(
    source: RecoverySnapshot, current: RecoverySnapshot
) -> None:
    if source.photos != current.photos:
        raise ArchiveIntegrityError("Photo metadata changed during rehearsal")
    if source.animals != current.animals:
        raise ArchiveIntegrityError("Animal metadata changed during rehearsal")
    if source.taxa != current.taxa:
        raise ArchiveIntegrityError("Taxonomy metadata changed during rehearsal")
    expected_jobs = dict(source.job_counts)
    running = expected_jobs.get("running", 0)
    expected_jobs["running"] = 0
    expected_jobs["failed"] = expected_jobs.get("failed", 0) + running
    if expected_jobs != dict(current.job_counts):
        raise ArchiveIntegrityError(
            "Classification jobs changed outside normal interrupted-job recovery"
        )


def _exercise_albums(engine: Engine, source: RecoverySnapshot) -> int:
    items: list[dict] = []
    page = 1
    total = 0
    with Session(engine) as session:
        while True:
            result = list_albums(
                session,
                page=page,
                page_size=100,
                query="",
                taxonomic_class=None,
                order=None,
                family=None,
                genus=None,
                species=None,
                only_with_photos=False,
                sort="name",
            )
            total = int(result["total"])
            batch = list(result["items"])
            items.extend(batch)
            if len(items) >= total or not batch:
                break
            page += 1
    if sum(int(item["animal_count"]) for item in items) != len(source.animals):
        raise ArchiveIntegrityError("Album animal counts do not match recovered data")
    linked_active = sum(
        not photo.deleted and photo.animal_id is not None for photo in source.photos
    )
    if sum(int(item["photo_count"]) for item in items) != linked_active:
        raise ArchiveIntegrityError("Album photo counts do not match recovered data")
    return total


def _reverify_source(
    backup_root: Path, manifest: BackupManifest, manifest_hash: str
) -> None:
    repeated = verify_backup(backup_root)
    if not repeated.valid:
        raise ArchiveIntegrityError(
            "Source backup changed during rehearsal: " + "; ".join(repeated.errors)
        )
    current_manifest_hash, _ = hash_file(backup_root / "manifest.json")
    if current_manifest_hash != manifest_hash:
        raise ArchiveIntegrityError("Source manifest changed during rehearsal")
    for entry in manifest.files:
        digest, size = hash_file(backup_root.joinpath(*entry.path.split("/")))
        if digest != entry.sha256 or size != entry.size_bytes:
            raise ArchiveIntegrityError(
                f"Source payload changed during rehearsal: {entry.path}"
            )


def _cleanup_staging(staging: Path | None, original: Exception) -> None:
    if staging is None:
        return
    if is_link_or_junction(staging):
        raise RehearsalSetupError(
            getattr(original, "stage", "copy"),
            f"{original}; incomplete rehearsal path became a link: {staging}",
        ) from original
    if not staging.exists():
        return
    try:
        shutil.rmtree(staging)
    except OSError as exc:
        raise RehearsalSetupError(
            getattr(original, "stage", "copy"),
            f"{original}; incomplete rehearsal remains at {staging}: {exc}",
        ) from original


def rehearse_backup(backup_path: Path, target: Path) -> RehearsalResult:
    verification, manifest_hash = _verify_source(backup_path)
    manifest = verification.manifest
    assert manifest is not None
    database_source = verification.backup_path / DATABASE_BACKUP_PATH
    try:
        source_snapshot = _read_schema_9_snapshot(database_source)
    except ArchiveIntegrityError as exc:
        raise RehearsalIntegrityError("backup verification", str(exc)) from exc

    final_target = _preflight_target(verification.backup_path, target)
    staging: Path | None = None
    engine: Engine | None = None
    stage: Stage = "copy"
    try:
        staging = final_target.parent / (
            f".{final_target.name}.faunavault-rehearsal-{uuid4().hex}"
        )
        staging.mkdir()
        settings = _copy_payload(verification.backup_path, staging, manifest)

        stage = "startup/migration"
        engine = create_database_engine(settings)
        initialized = initialize_archive_storage(engine, settings)
        expected_migrations = tuple(
            range(manifest.database.schema_version + 1, LATEST_SCHEMA_VERSION + 1)
        )
        if initialized.applied_migrations != expected_migrations:
            raise ArchiveIntegrityError(
                "Unexpected migration sequence: "
                f"expected {list(expected_migrations)}, "
                f"applied {list(initialized.applied_migrations)}"
            )
        recovered_jobs = recover_interrupted_jobs(engine)
        inventory = inspect_database(settings.database_path, LATEST_SCHEMA_VERSION)
        if inventory.migrations != list(range(1, LATEST_SCHEMA_VERSION + 1)):
            raise ArchiveIntegrityError(
                "Rehearsed database did not reach current schema"
            )

        stage = "semantic validation"
        current_snapshot = _read_current_snapshot(settings.database_path)
        _compare_recovery_snapshots(source_snapshot, current_snapshot)
        album_count = _exercise_albums(engine, source_snapshot)

        stage = "doctor"
        health = doctor(settings)
        if health.status != "HEALTHY":
            details = "; ".join(
                f"{finding.code}: {finding.message}"
                for finding in (*health.errors, *health.repairs)
            )
            raise ArchiveIntegrityError(details or f"Archive doctor: {health.status}")
        _reverify_source(verification.backup_path, manifest, manifest_hash)

        engine.dispose()
        engine = None
        stage = "copy"
        if final_target.exists() or is_link_or_junction(final_target):
            raise RehearsalSetupError(
                "target preflight", "Rehearsal target appeared during processing"
            )
        if contains_link_or_junction(staging):
            raise RehearsalSetupError(
                "copy", "Rehearsal staging path became a link or junction"
            )
        staging.rename(final_target)
        staging = None
        warnings = tuple(verification.warnings) + tuple(
            f"{finding.code}: {finding.message}" for finding in health.warnings
        )
        return RehearsalResult(
            backup_path=verification.backup_path,
            target=final_target,
            backup_format_version=manifest.backup_format_version,
            source_schema_version=manifest.database.schema_version,
            current_schema_version=LATEST_SCHEMA_VERSION,
            applied_migrations=initialized.applied_migrations,
            recovered_classification_jobs=recovered_jobs,
            photos=len(inventory.photos),
            active_photos=inventory.active_photos,
            trashed_photos=inventory.trashed_photos,
            animals=inventory.animals,
            taxa=inventory.taxa,
            albums=album_count,
            doctor_status=health.status,
            warnings=warnings,
        )
    except RehearsalError as exc:
        if engine is not None:
            engine.dispose()
        _cleanup_staging(staging, exc)
        raise
    except Exception as exc:
        if engine is not None:
            engine.dispose()
        if isinstance(exc, OSError):
            wrapped: RehearsalError = RehearsalSetupError(stage, str(exc))
        else:
            wrapped = RehearsalIntegrityError(stage, str(exc))
        _cleanup_staging(staging, wrapped)
        raise wrapped from exc
