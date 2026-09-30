from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

import pytest
from sqlmodel import Session, select

import app.backup.rehearsal as rehearsal_module
import app.cli.backup as backup_cli
import app.migrations as migrations_module
from app.backup.compatibility import SUPPORTED_BACKUP_SCHEMA_VERSIONS
from app.backup.manifest import DATABASE_BACKUP_PATH, read_manifest
from app.backup.rehearsal import (
    RehearsalError,
    RehearsalIntegrityError,
    rehearse_backup,
)
from app.backup.verify import verify_backup
from app.cli.backup import main as backup_main
from app.config import Settings
from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION
from app.models import Animal, ClassificationJob, Photo
from app.services.albums import list_albums
from app.services.archive_maintenance import Finding, HealthResult
from app.storage_startup import initialize_archive_storage

FIXTURE = Path(__file__).parent / "fixtures" / "backup_v1_schema9"


def _intermediate_backup(tmp_path, monkeypatch, schema):
    backup = _copy_fixture(tmp_path)
    database = backup / DATABASE_BACKUP_PATH
    settings = Settings(
        _env_file=None,
        data_dir=database.parent,
        image_dir=backup / "images",
        database_url=f"sqlite:///{database}",
    )
    engine = create_database_engine(settings)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(migrations_module, "LATEST_SCHEMA_VERSION", schema)
            assert migrations_module.run_migrations(engine, settings) == list(
                range(10, schema + 1)
            )
    finally:
        engine.dispose()
    with sqlite3.connect(database) as connection:
        connection.execute(
            "INSERT INTO collection VALUES (1, 'Preserved collection', 'preserved collection', "
            "'2026-09-01T12:00:00', '2026-09-01T12:00:00')"
        )
        connection.executemany(
            "INSERT INTO collection_photo VALUES (1, ?)", [(1,), (2,)]
        )
        connection.execute(
            "INSERT INTO classification_job "
            "(photo_id, status, batch_id, batch_kind, requested_model, fallback_attempted, "
            "prompt_version, attempt_count, created_at, queued_at, started_at, source_photo_updated_at) "
            "VALUES (1, 'running', 'compatibility', 'single', 'offline-test', 0, 'v1', 1, "
            "'2026-09-01T12:00:00', '2026-09-01T12:00:00', '2026-09-01T12:00:00', '2026-09-01T12:00:00')"
        )
        if schema >= 11:
            connection.execute(
                "UPDATE photo SET captured_at='2024-05-24T18:42:00', "
                "captured_at_offset_minutes=120, camera_make='SONY', "
                "image_width=10, image_height=10, latitude=46.05, longitude=14.50 WHERE id=1"
            )
        if schema >= 12:
            connection.execute(
                "UPDATE photo SET reviewed_at='2026-09-01T12:00:00' WHERE id=2"
            )
        if schema >= 13:
            connection.execute(
                "INSERT INTO smart_collection VALUES "
                "(1, 'All photos', 'all photos', 1, '{}', '2026-09-01T12:00:00', '2026-09-01T12:00:00')"
            )
        if schema >= 14:
            connection.execute(
                "INSERT INTO duplicate_pair VALUES (1, 2, 'phash64-v1:d4', '0000000000000000', '0000000000000001', 1, '2026-09-01T12:00:00', '2026-09-01T12:00:00')"
            )
            connection.execute(
                "INSERT INTO duplicate_scan_state VALUES ('phash64-v1:d4', 'complete', '2026-09-01T12:00:00', '2026-09-01T12:00:00', '2026-09-01T12:00:00', 2, 0, 1, 5, NULL)"
            )
        if schema >= 15:
            connection.execute(
                "UPDATE photo SET extracted_captured_at=captured_at, "
                "extracted_captured_at_offset_minutes=captured_at_offset_minutes, "
                "extracted_latitude=latitude, extracted_longitude=longitude"
            )
            connection.execute(
                "UPDATE photo SET captured_at='2025-03-14T23:45:12', "
                "capture_metadata_overridden=1, location_metadata_overridden=1 WHERE id=2"
            )
        if schema >= 16:
            connection.execute("UPDATE photo SET is_favorite=1, rating=5 WHERE id=1")
            connection.execute("UPDATE photo SET rating=2 WHERE id=2")
    manifest_path = backup / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["database"]["schema_version"] = schema
    payload["database"]["applied_migrations"] = list(range(1, schema + 1))
    payload["counts"]["classification_jobs"].update(total=1, running=1)
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")
    _refresh_database_manifest(backup)
    return backup


@pytest.mark.parametrize("schema", [10, 11, 12, 13, 14, 15, 16])
def test_supported_intermediate_schemas_verify_migrate_and_preserve_state(
    tmp_path, monkeypatch, schema
):
    fixture_before = _fingerprint(FIXTURE)
    backup = _intermediate_backup(tmp_path, monkeypatch, schema)
    source_before = _fingerprint(backup)
    assert verify_backup(backup).valid
    target = tmp_path / "rehearsal"
    result = rehearse_backup(backup, target)
    assert result.source_schema_version == schema
    assert result.current_schema_version == LATEST_SCHEMA_VERSION
    assert result.applied_migrations == tuple(
        range(schema + 1, LATEST_SCHEMA_VERSION + 1)
    )
    assert result.doctor_status == "HEALTHY"
    assert (
        result.active_photos,
        result.trashed_photos,
        result.collection_memberships,
    ) == (1, 1, 2)
    assert result.recovered_classification_jobs == 1
    with sqlite3.connect(target / "data" / "faunavault.db") as connection:
        assert (
            connection.execute("SELECT name FROM collection").fetchone()[0]
            == "Preserved collection"
        )
        assert connection.execute(
            "SELECT status, failure_code FROM classification_job"
        ).fetchone() == ("failed", "worker_interrupted")
        if schema >= 11:
            assert connection.execute(
                "SELECT camera_make, captured_at_offset_minutes, latitude FROM photo WHERE id=1"
            ).fetchone() == ("SONY", 120, 46.05)
        if schema >= 12:
            assert (
                connection.execute(
                    "SELECT reviewed_at FROM photo WHERE id=2"
                ).fetchone()[0]
                == "2026-09-01T12:00:00"
            )
        if schema >= 13:
            assert connection.execute(
                "SELECT name, query_version, query_json FROM smart_collection"
            ).fetchone() == ("All photos", 1, "{}")
        if schema >= 14:
            assert (
                connection.execute(
                    "SELECT dismissed_at FROM duplicate_pair"
                ).fetchone()[0]
                == "2026-09-01T12:00:00"
            )
            assert connection.execute(
                "SELECT status, processed FROM duplicate_scan_state"
            ).fetchone() == ("complete", 2)
        if schema >= 15:
            assert connection.execute(
                "SELECT captured_at, extracted_captured_at, capture_metadata_overridden, "
                "location_metadata_overridden FROM photo WHERE id=2"
            ).fetchone() == ("2025-03-14T23:45:12", None, 1, 1)
        if schema >= 16:
            assert connection.execute(
                "SELECT is_favorite, rating FROM photo ORDER BY id"
            ).fetchall() == [(1, 5), (0, 2)]
        else:
            assert connection.execute(
                "SELECT is_favorite, rating FROM photo ORDER BY id"
            ).fetchall() == [(0, None), (0, None)]
    for role in ("original", "resized", "thumbs"):
        for source in (backup / "images" / role).iterdir():
            assert (
                target / "images" / role / source.name
            ).read_bytes() == source.read_bytes()
    assert _fingerprint(backup) == source_before
    assert _fingerprint(FIXTURE) == fixture_before


def test_schema13_upgrade_failure_preserves_originals_and_retries(
    tmp_path, monkeypatch
):
    fixture_before = _fingerprint(FIXTURE)
    backup = _intermediate_backup(tmp_path, monkeypatch, 13)
    source_before = _fingerprint(backup)
    assert verify_backup(backup).valid
    runtime = tmp_path / "runtime"
    shutil.copytree(backup, runtime)
    database = runtime / DATABASE_BACKUP_PATH
    settings = Settings(
        _env_file=None,
        data_dir=database.parent,
        image_dir=runtime / "images",
        database_url=f"sqlite:///{database}",
    )
    with sqlite3.connect(database) as connection:
        database_before = tuple(connection.iterdump())
    originals_before = _fingerprint(settings.image_dirs["original"])
    existing_backups = set(database.parent.glob("*.pre-migrate-*.db"))
    engine = create_database_engine(settings)
    try:
        with monkeypatch.context() as patch:

            def fail_migration(_connection):
                raise RuntimeError("injected schema-16 migration failure")

            patch.setattr(migrations_module, "_migration_16", fail_migration)
            with pytest.raises(RuntimeError, match="schema-16 migration failure"):
                initialize_archive_storage(engine, settings)
        with sqlite3.connect(database) as connection:
            assert [
                row[0]
                for row in connection.execute(
                    "SELECT version FROM schema_migration ORDER BY version"
                )
            ] == list(range(1, 16))
        new_backups = set(database.parent.glob("*.pre-migrate-*.db")) - existing_backups
        assert len(new_backups) == 1
        migration_backup = new_backups.pop()
        with sqlite3.connect(migration_backup) as connection:
            assert tuple(connection.iterdump()) == database_before
            assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert connection.execute(
                "SELECT MAX(version) FROM schema_migration"
            ).fetchone() == (13,)
        assert _fingerprint(settings.image_dirs["original"]) == originals_before
        assert initialize_archive_storage(engine, settings).applied_migrations == (16,)
        assert initialize_archive_storage(engine, settings).applied_migrations == ()
        with sqlite3.connect(database) as connection:
            assert [
                row[0]
                for row in connection.execute(
                    "SELECT version FROM schema_migration ORDER BY version"
                )
            ] == list(range(1, 17))
            assert connection.execute(
                "SELECT is_favorite, rating FROM photo ORDER BY id"
            ).fetchall() == [(0, None), (0, None)]
            assert connection.execute(
                "SELECT captured_at, extracted_captured_at, capture_metadata_overridden, location_metadata_overridden FROM photo WHERE id=1"
            ).fetchone() == ("2024-05-24T18:42:00", "2024-05-24T18:42:00", 0, 0)
        assert _fingerprint(settings.image_dirs["original"]) == originals_before
        assert _fingerprint(backup) == source_before
        assert _fingerprint(FIXTURE) == fixture_before
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "schema,table,column",
    [
        (12, "photo", "reviewed_at"),
        (13, "photo", "reviewed_at"),
        (13, "smart_collection", "query_json"),
        (13, "smart_collection", "query_version"),
        (14, "duplicate_pair", "left_hash"),
        (14, "duplicate_scan_state", "reason"),
        (15, "photo", "extracted_captured_at"),
        (15, "photo", "extracted_captured_at_offset_minutes"),
        (15, "photo", "extracted_latitude"),
        (15, "photo", "extracted_longitude"),
        (15, "photo", "capture_metadata_overridden"),
        (15, "photo", "location_metadata_overridden"),
        (16, "photo", "is_favorite"),
        (16, "photo", "rating"),
    ],
)
def test_schema_claim_requires_actual_review_and_smart_columns(
    tmp_path, monkeypatch, schema, table, column
):
    backup = _intermediate_backup(tmp_path, monkeypatch, schema)
    with sqlite3.connect(backup / DATABASE_BACKUP_PATH) as connection:
        connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
    _refresh_database_manifest(backup)
    verification = verify_backup(backup)
    assert not verification.valid
    assert any(column in error for error in verification.errors)
    target = tmp_path / "must-not-exist"
    with pytest.raises(RehearsalIntegrityError):
        rehearse_backup(backup, target)
    assert not target.exists()


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fingerprint(root: Path) -> dict[str, tuple[str, int, int]]:
    return {
        path.relative_to(root).as_posix(): (
            _digest(path),
            path.stat().st_size,
            path.stat().st_mtime_ns,
        )
        for path in sorted(item for item in root.rglob("*") if item.is_file())
    }


def _copy_fixture(tmp_path: Path) -> Path:
    destination = tmp_path / "backup"
    shutil.copytree(FIXTURE, destination)
    return destination


def _refresh_database_manifest(backup: Path) -> None:
    manifest_path = backup / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    database_path = backup / DATABASE_BACKUP_PATH
    database_entry = next(
        entry for entry in payload["files"] if entry["role"] == "database"
    )
    old_size = database_entry["size_bytes"]
    database_entry["size_bytes"] = database_path.stat().st_size
    database_entry["sha256"] = _digest(database_path)
    payload["counts"]["payload_bytes"] += database_entry["size_bytes"] - old_size
    manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _target_settings(target: Path) -> Settings:
    return Settings(
        _env_file=None,
        data_dir=target / "data",
        image_dir=target / "images",
        database_url=f"sqlite:///{(target / 'data' / 'faunavault.db').as_posix()}",
    )


def test_frozen_schema9_fixture_verifies_rehearses_and_remains_immutable(tmp_path):
    before = _fingerprint(FIXTURE)

    verification = verify_backup(FIXTURE)
    target = tmp_path / "rehearsal target with spaces"
    result = rehearse_backup(FIXTURE, target)

    assert verification.valid
    assert verification.manifest is not None
    assert verification.manifest.database.schema_version == 9
    assert SUPPORTED_BACKUP_SCHEMA_VERSIONS == frozenset(
        {9, 10, 11, 12, 13, 14, 15, 16}
    )
    assert result.source_schema_version == 9
    assert result.current_schema_version == LATEST_SCHEMA_VERSION
    assert result.applied_migrations == tuple(range(10, LATEST_SCHEMA_VERSION + 1))
    assert result.photos == 2
    assert result.active_photos == 1
    assert result.trashed_photos == 1
    assert result.animals == 2
    assert result.taxa == 1
    assert result.collections == 0
    assert result.collection_memberships == 0
    assert result.albums == 2
    assert result.doctor_status == "HEALTHY"
    assert target.is_dir()
    assert (target / "data" / "faunavault.db").is_file()
    assert (target / "data" / "faunavault.pre-taxonomy.bak").is_file()
    assert (target / "images" / ".staging").is_dir()
    assert (target / "images" / ".purge").is_dir()

    manifest = read_manifest(FIXTURE / "manifest.json")
    for entry in manifest.files:
        if entry.role == "database":
            continue
        filename = Path(entry.path).name
        copied = target / "images" / entry.role / filename
        assert (
            copied.read_bytes() == FIXTURE.joinpath(*entry.path.split("/")).read_bytes()
        )

    settings = _target_settings(target)
    engine = create_database_engine(settings)
    with engine.connect() as connection:
        versions = list(
            connection.exec_driver_sql(
                "SELECT version FROM schema_migration ORDER BY version"
            ).scalars()
        )
    assert versions == list(range(1, LATEST_SCHEMA_VERSION + 1))
    with Session(engine) as session:
        photos = list(session.exec(select(Photo).order_by(Photo.id)).all())
        animals = list(session.exec(select(Animal).order_by(Animal.id)).all())
        albums = list_albums(
            session,
            page=1,
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
    engine.dispose()
    assert photos[0].display_title == "Ruby in the meadow"
    assert photos[0].tags == ["field", "favorite"]
    assert photos[0].perceptual_hash == "0123456789abcdef"
    assert photos[1].deleted_at is not None
    assert photos[1].perceptual_hash is None
    assert [animal.display_name for animal in animals] == ["Ruby", "Pond visitor"]
    assert {item["scientific_name"] for item in albums["items"]} == {
        "Vulpes vulpes",
        "Hyla arborea",
    }
    assert _fingerprint(FIXTURE) == before

    second = rehearse_backup(FIXTURE, tmp_path / "second-target")
    assert second.applied_migrations == result.applied_migrations
    assert (second.photos, second.animals, second.taxa, second.albums) == (2, 2, 1, 2)
    assert _fingerprint(FIXTURE) == before


def test_cli_rehearsal_never_loads_or_touches_live_settings(
    tmp_path, monkeypatch, capsys
):
    live = tmp_path / "configured-live"
    (live / "images" / "original").mkdir(parents=True)
    (live / "faunavault.db").write_bytes(b"DO NOT OPEN OR CHANGE")
    (live / "images" / "original" / "sentinel.png").write_bytes(b"sentinel")
    before = _fingerprint(live)
    monkeypatch.setenv("DATA_DIR", str(live))
    monkeypatch.setenv("IMAGE_DIR", str(live / "images"))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{live / 'faunavault.db'}")

    def reject_live_settings():
        raise AssertionError("normal live settings were requested")

    monkeypatch.setattr(backup_cli, "get_settings", reject_live_settings)
    target = tmp_path / "isolated"

    exit_code = backup_main(["rehearse", str(FIXTURE), str(target)])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "Backup: VALID" in captured.out
    assert "Source schema: 9" in captured.out
    assert "Archive doctor: HEALTHY" in captured.out
    assert "Restore rehearsal: PASSED" in captured.out
    assert _fingerprint(live) == before


def test_cli_rehearsal_failure_exit_codes_and_stages(tmp_path, capsys):
    corrupt = _copy_fixture(tmp_path)
    (corrupt / "images" / "original" / "active.png").write_bytes(b"changed")

    integrity_exit = backup_main(
        ["rehearse", str(corrupt), str(tmp_path / "integrity-target")]
    )
    integrity_output = capsys.readouterr()

    existing = tmp_path / "existing-target"
    existing.mkdir()
    setup_exit = backup_main(["rehearse", str(FIXTURE), str(existing)])
    setup_output = capsys.readouterr()

    assert integrity_exit == 1
    assert "Stage: backup verification" in integrity_output.err
    assert setup_exit == 2
    assert "Stage: target preflight" in setup_output.err


def _corrupt_backup(backup: Path, case: str) -> None:
    manifest_path = backup / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if case == "invalid_manifest":
        manifest_path.write_text("{invalid", encoding="utf-8")
    elif case == "checksum":
        (backup / "images" / "original" / "active.png").write_bytes(b"changed")
    elif case == "missing":
        (backup / "images" / "thumbs" / "active_thumb.png").unlink()
    elif case == "format":
        payload["backup_format_version"] = 99
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")
    elif case == "schema":
        payload["database"]["schema_version"] = 8
        payload["database"]["applied_migrations"] = list(range(1, 9))
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")
    elif case == "schema_disagreement":
        connection = sqlite3.connect(backup / DATABASE_BACKUP_PATH)
        connection.execute("DELETE FROM schema_migration WHERE version = 9")
        connection.commit()
        connection.close()
        _refresh_database_manifest(backup)
    elif case == "sqlite":
        (backup / DATABASE_BACKUP_PATH).write_bytes(b"not a SQLite database")
        _refresh_database_manifest(backup)
    elif case == "foreign_key":
        connection = sqlite3.connect(backup / DATABASE_BACKUP_PATH)
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("UPDATE photo SET animal_id = 999999 WHERE id = 1")
        connection.commit()
        connection.close()
        _refresh_database_manifest(backup)
    else:
        raise AssertionError(case)


@pytest.mark.parametrize(
    "case",
    [
        "invalid_manifest",
        "checksum",
        "missing",
        "format",
        "schema",
        "schema_disagreement",
        "sqlite",
        "foreign_key",
    ],
)
def test_corrupt_or_unsupported_backup_fails_before_target_writes(tmp_path, case):
    backup = _copy_fixture(tmp_path)
    _corrupt_backup(backup, case)
    target = tmp_path / "target"

    with pytest.raises(RehearsalError) as captured:
        rehearse_backup(backup, target)

    assert captured.value.exit_code == 1
    assert captured.value.stage == "backup verification"
    assert not target.exists()
    assert not list(tmp_path.glob(f".{target.name}.faunavault-rehearsal-*"))


@pytest.mark.parametrize("existing_payload", [None, b"occupied"])
def test_existing_target_is_never_used_or_changed(tmp_path, existing_payload):
    target = tmp_path / "target"
    target.mkdir()
    if existing_payload is not None:
        (target / "sentinel").write_bytes(existing_payload)
    before = _fingerprint(target)

    with pytest.raises(RehearsalError) as captured:
        rehearse_backup(FIXTURE, target)

    assert captured.value.exit_code == 2
    assert captured.value.stage == "target preflight"
    assert _fingerprint(target) == before


def test_backup_target_overlap_is_rejected(tmp_path):
    backup = _copy_fixture(tmp_path)
    for target in (backup, backup / "nested-target", tmp_path):
        with pytest.raises(RehearsalError) as captured:
            rehearse_backup(backup, target)
        assert captured.value.exit_code == 2
        assert captured.value.stage == "target preflight"


@pytest.mark.parametrize(
    "target", [Path("https://example.test/rehearsal"), Path(r"\\server\share\target")]
)
def test_remote_or_url_target_is_rejected(target):
    with pytest.raises(RehearsalError, match="Remote and URL") as captured:
        rehearse_backup(FIXTURE, target)
    assert captured.value.exit_code == 2


def test_linked_target_ancestor_is_rejected_when_supported(tmp_path):
    real_parent = tmp_path / "real-parent"
    real_parent.mkdir()
    linked_parent = tmp_path / "linked-parent"
    try:
        linked_parent.symlink_to(real_parent, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlink creation is unavailable")

    with pytest.raises(RehearsalError, match="link or junction"):
        rehearse_backup(FIXTURE, linked_parent / "target")


@pytest.mark.parametrize("failure_stage", ["copy", "startup", "doctor"])
def test_failed_rehearsal_cleans_staging_and_never_publishes(
    tmp_path, monkeypatch, failure_stage
):
    target = tmp_path / "target"
    if failure_stage == "copy":
        original = rehearsal_module.copy_and_hash_stable
        calls = 0

        def fail_copy(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RehearsalIntegrityError("copy", "injected copy failure")
            return original(source, destination)

        monkeypatch.setattr(rehearsal_module, "copy_and_hash_stable", fail_copy)
    elif failure_stage == "startup":
        monkeypatch.setattr(
            rehearsal_module,
            "initialize_archive_storage",
            lambda _engine, _settings: (_ for _ in ()).throw(
                RuntimeError("injected startup failure")
            ),
        )
    else:
        monkeypatch.setattr(
            rehearsal_module,
            "doctor",
            lambda _settings: HealthResult(
                findings=[Finding("repair", "thumbnail_missing", "injected defect")]
            ),
        )

    with pytest.raises(RehearsalError):
        rehearse_backup(FIXTURE, target)

    assert not target.exists()
    assert not list(tmp_path.glob(f".{target.name}.faunavault-rehearsal-*"))


def test_running_job_uses_local_startup_recovery_without_worker(tmp_path):
    backup = _copy_fixture(tmp_path)
    connection = sqlite3.connect(backup / DATABASE_BACKUP_PATH)
    connection.execute(
        """
        INSERT INTO classification_job (
            photo_id, status, batch_id, batch_kind, requested_model,
            fallback_attempted, prompt_version, attempt_count, created_at,
            queued_at, started_at, source_photo_updated_at
        ) VALUES (1, 'running', 'fixture-batch', 'single', 'offline-test',
                  0, 'v1', 1, '2026-08-20T08:00:00+00:00',
                  '2026-08-20T08:00:00+00:00',
                  '2026-08-20T08:00:00+00:00',
                  '2026-08-20T08:00:00+00:00')
        """
    )
    connection.commit()
    connection.close()
    manifest_path = backup / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["counts"]["classification_jobs"]["total"] = 1
    payload["counts"]["classification_jobs"]["running"] = 1
    manifest_path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    _refresh_database_manifest(backup)
    target = tmp_path / "target"

    result = rehearse_backup(backup, target)

    assert result.recovered_classification_jobs == 1
    engine = create_database_engine(_target_settings(target))
    with Session(engine) as session:
        job = session.exec(select(ClassificationJob)).one()
    engine.dispose()
    assert job.status == "failed"
    assert job.failure_code == "worker_interrupted"
