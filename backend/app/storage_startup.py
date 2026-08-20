from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import Engine
from sqlmodel import Session, SQLModel

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


def initialize_archive_storage(
    engine: Engine, settings: Settings
) -> StorageInitializationResult:
    """Run the authoritative storage-only application startup path."""
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
