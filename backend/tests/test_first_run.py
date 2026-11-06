from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from tomllib import loads

import pytest

import app.config as config
import app.version as version_module
from app.benchmark.safety import IsolatedSettings
from app.database import create_database_engine
from app.metadata_types import SHOOTING_SETTING_FIELDS
from app.migrations import run_migrations
from app.storage_startup import initialize_archive_storage, validate_storage_selection
from app.version import APP_VERSION


def test_version_uses_manifest_and_installed_metadata(monkeypatch, tmp_path):
    manifest = Path(__file__).resolve().parents[1] / "pyproject.toml"
    assert (
        APP_VERSION == loads(manifest.read_text(encoding="utf-8"))["project"]["version"]
    )
    monkeypatch.setattr(
        version_module, "__file__", str(tmp_path / "app" / "version.py")
    )
    names = []
    monkeypatch.setattr(
        version_module, "version", lambda name: names.append(name) or "2.3.4"
    )
    assert version_module.application_version() == "2.3.4"
    assert names == ["backend"]


def test_portable_defaults_and_implicit_legacy_archive_refusal(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BACKEND_DIR", tmp_path)
    database = tmp_path / "legacy.db"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE photo (id INTEGER PRIMARY KEY)")
        connection.execute("INSERT INTO photo VALUES (1)")
    settings = IsolatedSettings(database_url=f"sqlite:///{database}")
    assert settings.image_dir == tmp_path / "data" / "images"
    before = database.read_bytes()
    engine = create_database_engine(settings)
    try:
        with pytest.raises(ValueError, match="Set IMAGE_DIR"):
            initialize_archive_storage(engine, settings)
    finally:
        engine.dispose()
    assert database.read_bytes() == before
    assert not settings.image_dir.exists()
    explicit = IsolatedSettings(
        database_url=settings.database_url, image_dir=tmp_path / "existing images"
    )
    validate_storage_selection(explicit)
    assert explicit.image_dir == tmp_path / "existing images"


def test_fresh_application_is_offline_isolated_and_preserves_archive(tmp_path):
    """Use a separate process so import-time globals can never select live storage."""
    script = r"""
import hashlib
import sys
from io import BytesIO
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

import app.config as config
from app.benchmark.safety import IsolatedSettings

root = Path(sys.argv[1])
settings = IsolatedSettings(
    data_dir=root / "data", image_dir=root / "images",
    database_url=f"sqlite:///{root / 'data' / 'faunavault.db'}",
    ollama_base_url="http://127.0.0.1:9", gbif_base_url="http://127.0.0.1:9",
)
config.get_settings = lambda: settings
network_attempts = []
def reject_network(*args, **kwargs):
    network_attempts.append(True)
    raise AssertionError("First run must not contact an external service")
httpx.HTTPTransport.handle_request = reject_network

import app.main as main
from PIL import Image
from app.migrations import LATEST_SCHEMA_VERSION
from app.services.archive_maintenance import doctor
from app.version import APP_VERSION

assert not settings.database_path.exists()
assert not settings.image_dir.exists()
with TestClient(main.app) as client:
    assert client.get("/health").json() == {"status": "ok", "version": APP_VERSION}
    assert client.get("/openapi.json").json()["info"]["version"] == APP_VERSION
    page = client.get("/catalog/photos").json()
    assert page["total"] == 0 and page["items"] == []
    assert client.get("/photos").json() == []
    timeline = client.get("/catalog/timeline").json()
    assert timeline["years"] == [] and timeline["unknown_capture_count"] == 0
    assert client.get("/catalog/map").json() == []
    albums = client.get("/species-albums").json()
    assert albums["items"] == [] and albums["total"] == 0
    assert client.get("/collections").json() == []
    assert client.get("/smart-collections").json() == []
    inbox = client.get("/review").json()
    assert inbox["total"] == 0 and inbox["photo"] is None
    duplicates = client.get("/duplicates/review").json()
    assert duplicates["total"] == 0 and duplicates["pair"] is None
    summary = client.get("/duplicates/summary").json()
    assert summary["unresolved"] == summary["dismissed"] == summary["missing_fingerprints"] == 0
    assert summary["scan"] is None
    trash = client.get("/trash/photos").json()
    assert trash["total"] == 0 and trash["items"] == []
    with main.engine.connect() as connection:
        versions = list(connection.exec_driver_sql("SELECT version FROM schema_migration ORDER BY version").scalars())
        assert versions == list(range(1, LATEST_SCHEMA_VERSION + 1))
        columns = {row[1]: row[2] for row in connection.exec_driver_sql("PRAGMA table_info(photo)")}
        assert columns["iso_speed"] == "INTEGER"
        assert all(columns[field] == "REAL" for field in ("aperture_f_number", "exposure_time_seconds", "focal_length_mm"))
        indexes = set(connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='index'").scalars())
        assert {
            "ix_photo_catalog_active_created", "ix_photo_catalog_active_status_created",
            "ix_photo_catalog_active_category_created", "ix_photo_catalog_active_captured",
            "ix_animal_legacy_species_group", "ix_collection_photo_photo_collection",
        } <= indexes
        connection.exec_driver_sql("SELECT reviewed_at, captured_at, perceptual_hash FROM photo LIMIT 0")
        connection.exec_driver_sql("SELECT is_favorite, rating, culling_state FROM photo LIMIT 0")
        assert "ix_photo_culling_state" not in indexes
        connection.exec_driver_sql("SELECT extracted_captured_at, extracted_captured_at_offset_minutes, extracted_latitude, extracted_longitude, capture_metadata_overridden, location_metadata_overridden FROM photo LIMIT 0")
        connection.exec_driver_sql("SELECT status, attempt_count, prompt_version FROM classification_job LIMIT 0")
        connection.exec_driver_sql("SELECT query_version, query_json FROM smart_collection LIMIT 0")
        connection.exec_driver_sql("SELECT left_photo_id, right_photo_id, dismissed_at FROM duplicate_pair LIMIT 0")
        connection.exec_driver_sql("SELECT status, last_successful_at FROM duplicate_scan_state LIMIT 0")
        assert {"ix_duplicate_pair_queue", "ix_duplicate_pair_right"} <= indexes
    assert doctor(settings).status == "HEALTHY"
    payload = BytesIO()
    Image.new("RGB", (40, 30), "green").save(payload, format="JPEG")
    upload = client.post("/photos/upload", files={"file": ("first-run.jpg", payload.getvalue(), "image/jpeg")})
    assert upload.status_code == 200, upload.text
    photo = upload.json()
    assert photo["culling_state"] is None
    original = settings.image_dirs["original"] / photo["stored_filename"]
    before = (original.read_bytes(), original.stat().st_mtime_ns)
    first_backups = {item.name: item.read_bytes() for item in settings.database_path.parent.glob("*.pre-*")}
with TestClient(main.app) as client:
    assert client.get("/catalog/photos").json()["total"] == 1
    assert client.get(f"/photos/{photo['id']}").json()["original_filename"] == "first-run.jpg"
assert (original.read_bytes(), original.stat().st_mtime_ns) == before
assert hashlib.sha256(before[0]).hexdigest() == photo["content_sha256"]
assert all((settings.database_path.parent / name).read_bytes() == content for name, content in first_backups.items())
all_backups = {item.name: item.read_bytes() for item in settings.database_path.parent.glob("*.pre-*")}
with TestClient(main.app):
    pass
assert {item.name: item.read_bytes() for item in settings.database_path.parent.glob("*.pre-*")} == all_backups
assert doctor(settings).status == "HEALTHY"
assert not network_attempts
main.engine.dispose()
print("Fresh initialization, schema, offline startup, and preservation: PASS")
"""
    # Deliberately hostile inherited config proves constructor-only settings win.
    environment = {
        **os.environ,
        "IMAGE_DIR": str(tmp_path / "must-not-touch"),
        "DATABASE_URL": "postgresql://invalid/ignored",
        "OLLAMA_KEEP_ALIVE": "invalid-ignored",
    }
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path / "fresh archive")],
        cwd=Path(__file__).resolve().parents[1],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "preservation: PASS" in result.stdout
    assert not (tmp_path / "must-not-touch").exists()


def test_schema_21_to_22_preserves_rows_and_creates_pre_migration_backup(tmp_path):
    database = tmp_path / "archive.db"
    settings = IsolatedSettings(
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database}",
    )
    engine = create_database_engine(settings)
    try:
        initialize_archive_storage(engine, settings)
        with sqlite3.connect(database) as connection:
            for column in SHOOTING_SETTING_FIELDS:
                connection.execute(f"ALTER TABLE photo DROP COLUMN {column}")
            connection.execute("DROP TABLE sighting_photo")
            connection.execute("DROP TABLE sighting")
            connection.execute("DELETE FROM schema_migration WHERE version >= 22")
            connection.execute(
                "INSERT INTO photo (id, original_filename, stored_filename, resized_filename, "
                "thumbnail_filename, status, created_at, updated_at, camera_make) "
                "VALUES (1, 'fox.jpg', 'original.jpg', 'resized.jpg', 'thumb.jpg', "
                "'classified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Canon')"
            )
            previous_backups = set(tmp_path.glob("*.pre-migrate-*.db"))
        assert run_migrations(engine, settings) == [22, 23]
        assert run_migrations(engine, settings) == []
        with sqlite3.connect(database) as connection:
            assert connection.execute(
                "SELECT camera_make, status, aperture_f_number, exposure_time_seconds, "
                "iso_speed, focal_length_mm FROM photo WHERE id = 1"
            ).fetchone() == ("Canon", "classified", None, None, None, None)
            for column, invalid in (
                ("iso_speed", 2.5),
                ("iso_speed", 0),
                ("aperture_f_number", -1),
                ("focal_length_mm", "unknown"),
                ("exposure_time_seconds", float("inf")),
            ):
                with pytest.raises(sqlite3.IntegrityError):
                    connection.execute(f"UPDATE photo SET {column} = ?", (invalid,))
        (backup,) = set(tmp_path.glob("*.pre-migrate-*.db")) - previous_backups
        with sqlite3.connect(backup) as connection:
            assert connection.execute(
                "SELECT max(version) FROM schema_migration"
            ).fetchone() == (21,)
            assert connection.execute(
                "SELECT original_filename FROM photo"
            ).fetchone() == ("fox.jpg",)
            assert not set(SHOOTING_SETTING_FIELDS).intersection(
                row[1] for row in connection.execute("PRAGMA table_info(photo)")
            )
    finally:
        engine.dispose()
