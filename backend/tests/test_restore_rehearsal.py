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

FIXTURE = Path(__file__).parent / "fixtures" / "backup_v1_schema9"


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
    assert SUPPORTED_BACKUP_SCHEMA_VERSIONS == frozenset({9})
    assert result.source_schema_version == 9
    assert result.current_schema_version == LATEST_SCHEMA_VERSION
    assert result.applied_migrations == tuple(range(10, LATEST_SCHEMA_VERSION + 1))
    assert result.photos == 2
    assert result.active_photos == 1
    assert result.trashed_photos == 1
    assert result.animals == 2
    assert result.taxa == 1
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
