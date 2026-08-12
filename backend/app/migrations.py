from __future__ import annotations

import hashlib
import logging
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import Engine, inspect, text
from sqlalchemy.engine import make_url

from app.config import BACKEND_DIR, Settings

logger = logging.getLogger(__name__)
LATEST_SCHEMA_VERSION = 7


def database_path_for_engine(engine: Engine) -> Path | None:
    url = make_url(str(engine.url))
    if (
        url.get_backend_name() != "sqlite"
        or not url.database
        or url.database == ":memory:"
    ):
        return None
    path = Path(url.database)
    return path if path.is_absolute() else (BACKEND_DIR / path).resolve()


def create_migration_backup(database_path: Path) -> Path | None:
    if not database_path.exists() or database_path.stat().st_size == 0:
        return None
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S-%f")
    backup_path = database_path.with_name(
        f"{database_path.stem}.pre-migrate-{timestamp}{database_path.suffix}"
    )
    source = sqlite3.connect(database_path)
    destination = sqlite3.connect(backup_path)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    return backup_path


def _columns(connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(text(f"PRAGMA table_info({table})"))}


def _migration_2(connection) -> None:
    columns = _columns(connection, "photo")
    additions = {
        "display_title": "TEXT",
        "breed_guess": "TEXT",
        "animal_id": "INTEGER",
        "content_sha256": "TEXT",
        "original_size_bytes": "INTEGER",
        "media_type": "TEXT",
        "deleted_at": "DATETIME",
    }
    for name, sql_type in additions.items():
        if name not in columns:
            connection.execute(text(f"ALTER TABLE photo ADD COLUMN {name} {sql_type}"))
    connection.execute(
        text("CREATE INDEX IF NOT EXISTS ix_photo_animal_id ON photo (animal_id)")
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_photo_content_sha256 ON photo (content_sha256)"
        )
    )
    connection.execute(
        text("CREATE INDEX IF NOT EXISTS ix_photo_deleted_at ON photo (deleted_at)")
    )


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _migration_3(connection, settings: Settings) -> None:
    rows = connection.execute(
        text(
            "SELECT id, stored_filename FROM photo "
            "WHERE content_sha256 IS NULL OR original_size_bytes IS NULL"
        )
    ).all()
    original_dir = settings.image_dirs["original"]
    missing = 0
    for photo_id, filename in rows:
        safe_name = Path(filename).name
        path = original_dir / safe_name
        if not path.is_file():
            missing += 1
            continue
        digest, size = _hash_file(path)
        connection.execute(
            text(
                "UPDATE photo SET content_sha256 = :digest, "
                "original_size_bytes = :size WHERE id = :photo_id"
            ),
            {"digest": digest, "size": size, "photo_id": photo_id},
        )
    if missing:
        logger.warning(
            "Hash backfill skipped %s photos with missing originals", missing
        )


def _migration_4(connection) -> None:
    connection.execute(
        text(
            """
            UPDATE photo
            SET media_type = CASE
                WHEN lower(stored_filename) LIKE '%.jpg'
                    OR lower(stored_filename) LIKE '%.jpeg' THEN 'image/jpeg'
                WHEN lower(stored_filename) LIKE '%.png' THEN 'image/png'
                WHEN lower(stored_filename) LIKE '%.webp' THEN 'image/webp'
                ELSE NULL
            END
            WHERE media_type IS NULL
            """
        )
    )


def _migration_5(normalize_metadata: Callable[[], None] | None) -> None:
    if normalize_metadata is None:
        raise RuntimeError("Migration 5 requires domestic metadata normalization")
    normalize_metadata()


def _migration_6(connection) -> None:
    connection.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS classification_job (
                id INTEGER PRIMARY KEY,
                photo_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
                batch_id TEXT NOT NULL,
                batch_kind TEXT NOT NULL
                    CHECK (batch_kind IN ('single', 'pending_batch', 'reclassification')),
                requested_model TEXT NOT NULL,
                fallback_model TEXT,
                actual_model TEXT,
                fallback_attempted BOOLEAN NOT NULL DEFAULT 0,
                prompt_version TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
                created_at DATETIME NOT NULL,
                queued_at DATETIME NOT NULL,
                started_at DATETIME,
                finished_at DATETIME,
                duration_ms INTEGER,
                failure_code TEXT,
                failure_message TEXT,
                classification_status TEXT
                    CHECK (classification_status IS NULL OR classification_status IN ('classified', 'needs_review')),
                source_photo_updated_at DATETIME NOT NULL,
                FOREIGN KEY(photo_id) REFERENCES photo(id) ON DELETE CASCADE
            )
            """
        )
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_classification_job_status_queued "
            "ON classification_job (status, queued_at, id)"
        )
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_classification_job_photo_created "
            "ON classification_job (photo_id, created_at, id)"
        )
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_classification_job_batch_id "
            "ON classification_job (batch_id)"
        )
    )
    connection.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_classification_job_active_photo "
            "ON classification_job (photo_id) "
            "WHERE status IN ('queued', 'running')"
        )
    )


def _migration_7(connection) -> None:
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_photo_catalog_active_created "
            "ON photo (deleted_at, created_at DESC, id DESC)"
        )
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_photo_catalog_active_status_created "
            "ON photo (deleted_at, status, created_at DESC, id DESC)"
        )
    )
    connection.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_photo_catalog_active_category_created "
            "ON photo (deleted_at, category, created_at DESC, id DESC)"
        )
    )


def run_migrations(
    engine: Engine,
    settings: Settings,
    normalize_metadata: Callable[[], None] | None = None,
) -> list[int]:
    if not inspect(engine).has_table("photo"):
        return []

    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migration "
                "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
            )
        )
        applied = {
            row[0]
            for row in connection.execute(text("SELECT version FROM schema_migration"))
        }

    pending = [
        version
        for version in range(2, LATEST_SCHEMA_VERSION + 1)
        if version not in applied
    ]
    if not pending:
        return []

    database_path = database_path_for_engine(engine)
    if database_path is not None:
        backup = create_migration_backup(database_path)
        if backup is not None:
            logger.info("Created pre-migration SQLite backup: %s", backup)

    completed: list[int] = []
    for version in pending:
        with engine.begin() as connection:
            if version == 2:
                _migration_2(connection)
            elif version == 3:
                _migration_3(connection, settings)
            elif version == 4:
                _migration_4(connection)
            elif version == 5:
                _migration_5(normalize_metadata)
            elif version == 6:
                _migration_6(connection)
            elif version == 7:
                _migration_7(connection)
            connection.execute(
                text(
                    "INSERT INTO schema_migration(version, applied_at) "
                    "VALUES (:version, CURRENT_TIMESTAMP)"
                ),
                {"version": version},
            )
        completed.append(version)
    return completed
