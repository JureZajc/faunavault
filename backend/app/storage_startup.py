from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Engine
from sqlmodel import Session, SQLModel

from app.archive_integrity import open_read_only_database
from app.config import Settings
from app.migrations import (
    backup_database_before_taxonomy_migration,
    migrate_animals_and_taxonomy,
    run_migrations,
)
from app.models import Animal, Photo, Taxon
from app.services.classification import normalize_existing_domestic_metadata
from app.services.photo_lifecycle import ensure_storage, reconcile_purge_journal


@dataclass(frozen=True)
class StorageInitializationResult:
    applied_migrations: tuple[int, ...]


def validate_storage_selection(settings: Settings) -> None:
    """Refuse an implicit switch of a populated archive to empty image storage."""
    database = settings.database_path
    if "image_dir" in settings.model_fields_set or database is None:
        return
    if not database.is_file():
        return
    originals = settings.image_dirs["original"]
    if originals.is_dir() and next(originals.iterdir(), None) is not None:
        return
    connection = open_read_only_database(database)
    try:
        has_photos = (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='photo'"
            ).fetchone()
            and connection.execute("SELECT 1 FROM photo LIMIT 1").fetchone()
        )
    finally:
        connection.close()
    if has_photos:
        raise ValueError(
            "An existing populated database has no photos in the portable default "
            "original directory. Set IMAGE_DIR in backend/.env to your existing "
            "image root before starting. No archive paths have been changed."
        )


def initialize_archive_storage(
    engine: Engine, settings: Settings
) -> StorageInitializationResult:
    """Run the authoritative storage-only application startup path."""
    validate_storage_selection(settings)
    ensure_storage(settings)
    backup_database_before_taxonomy_migration(engine)
    SQLModel.metadata.create_all(
        engine, tables=[Taxon.__table__, Animal.__table__, Photo.__table__]
    )
    migrate_animals_and_taxonomy(engine)
    applied = run_migrations(
        engine,
        settings,
        lambda: normalize_existing_domestic_metadata(engine),
    )
    with Session(engine) as session:
        reconcile_purge_journal(session, settings)
    return StorageInitializationResult(tuple(applied))
