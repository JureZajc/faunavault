from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from sqlmodel import Session, SQLModel, create_engine

from app.backup.integrity import BackupError
from app.backup.manifest import read_manifest
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.cli.backup import main as backup_main
from app.config import Settings
from app.models import Animal, ClassificationJob, Photo, Taxon, utc_now


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


@pytest.fixture()
def archive(tmp_path):
    database_path = tmp_path / "source" / "faunavault.db"
    image_root = tmp_path / "source" / "images"
    database_path.parent.mkdir()
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "source",
        image_dir=image_root,
        database_url=f"sqlite:///{database_path}",
    )
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True)
    settings.staging_dir.mkdir()
    settings.purge_dir.mkdir()
    engine = create_engine(settings.resolved_database_url)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE schema_migration "
            "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
        for migration in range(1, 10):
            connection.exec_driver_sql(
                "INSERT INTO schema_migration VALUES (?, CURRENT_TIMESTAMP)",
                (migration,),
            )

    source_payloads: dict[Path, bytes] = {}
    with Session(engine) as session:
        taxon = Taxon(
            external_taxon_id="5219404",
            scientific_name="Vulpes vulpes",
            canonical_name="Vulpes vulpes",
            common_name="Red fox",
            taxonomic_rank="SPECIES",
        )
        session.add(taxon)
        session.flush()
        for index, deleted in ((1, False), (2, True)):
            animal = Animal(identifier=f"FV-TEST-{index}", taxon_id=taxon.id)
            session.add(animal)
            session.flush()
            original = f"photo-{index}.jpg"
            resized = f"photo-{index}_resized.jpg"
            thumbnail = f"photo-{index}_thumb.jpg"
            original_payload = f"original-{index}".encode()
            payloads = {
                settings.image_dirs["original"] / original: original_payload,
                settings.image_dirs["resized"] / resized: f"resized-{index}".encode(),
                settings.image_dirs["thumbs"] / thumbnail: f"thumb-{index}".encode(),
            }
            for path, payload in payloads.items():
                path.write_bytes(payload)
                source_payloads[path] = payload
            photo = Photo(
                original_filename=original,
                stored_filename=original,
                resized_filename=resized,
                thumbnail_filename=thumbnail,
                animal_id=animal.id,
                content_sha256=digest(original_payload),
                original_size_bytes=len(original_payload),
                media_type="image/jpeg",
                deleted_at=utc_now() if deleted else None,
            )
            session.add(photo)
            session.flush()
            if index == 1:
                session.add(
                    ClassificationJob(
                        photo_id=photo.id,
                        status="running",
                        batch_id="test-batch",
                        batch_kind="single",
                        requested_model="test-model",
                        prompt_version="v1",
                        source_photo_updated_at=photo.updated_at,
                    )
                )
        session.commit()
    engine.dispose()
    destination = tmp_path / "backups"
    destination.mkdir()
    return settings, destination, source_payloads


def test_create_backup_is_complete_portable_and_verifiable(archive):
    settings, destination, source_payloads = archive
    database_before = settings.database_path.read_bytes()

    backup_path, result = create_backup(destination, settings)

    assert result.valid
    assert backup_path.parent == destination
    assert backup_path.name.startswith("faunavault-backup-")
    manifest = read_manifest(backup_path / "manifest.json")
    assert manifest.backup_format_version == 1
    assert manifest.database.schema_version == 9
    assert manifest.database.applied_migrations == list(range(1, 10))
    assert manifest.counts.photos == 2
    assert manifest.counts.active_photos == 1
    assert manifest.counts.trashed_photos == 1
    assert manifest.counts.animals == 2
    assert manifest.counts.taxa == 1
    assert manifest.counts.classification_jobs.running == 1
    assert manifest.counts.payload_files == 7
    assert manifest.diagnostics is None
    raw_manifest = (backup_path / "manifest.json").read_text(encoding="utf-8")
    assert str(settings.database_path) not in raw_manifest
    assert str(settings.image_dir) not in raw_manifest
    assert [entry.path for entry in manifest.files] == sorted(
        entry.path for entry in manifest.files
    )
    for role in ("original", "resized", "thumbs"):
        assert (backup_path / "images" / role).is_dir()
    assert settings.database_path.read_bytes() == database_before
    for path, payload in source_payloads.items():
        assert path.read_bytes() == payload


def test_verify_uses_only_backup_and_ignores_optional_diagnostics(archive):
    settings, destination, _ = archive
    backup_path, _ = create_backup(destination, settings)
    payload = json.loads((backup_path / "manifest.json").read_text(encoding="utf-8"))
    payload["diagnostics"] = {
        "source_database_path": "Z:/no-longer-exists/archive.db",
        "source_image_root": "Z:/no-longer-exists/images",
    }
    (backup_path / "manifest.json").write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    result = verify_backup(backup_path)

    assert result.valid


def test_verify_detects_changed_missing_and_extra_payloads(archive):
    settings, destination, _ = archive
    backup_path, _ = create_backup(destination, settings)
    manifest = read_manifest(backup_path / "manifest.json")
    original = next(entry for entry in manifest.files if entry.role == "original")
    original_path = backup_path.joinpath(*original.path.split("/"))
    original_path.write_bytes(b"corrupted")

    changed = verify_backup(backup_path)

    assert not changed.valid
    assert any("mismatch" in error for error in changed.errors)
    original_path.unlink()
    missing = verify_backup(backup_path)
    assert not missing.valid
    assert any("Missing" in error for error in missing.errors)

    original_path.write_bytes(b"corrupted")
    (backup_path / "notes.txt").write_text("extra", encoding="utf-8")
    extra = verify_backup(backup_path)
    assert any("Unexpected file: notes.txt" in warning for warning in extra.warnings)


def test_orphans_are_warned_and_excluded(archive):
    settings, destination, _ = archive
    orphan = settings.image_dirs["original"] / "orphan.jpg"
    orphan.write_bytes(b"not owned")

    backup_path, result = create_backup(destination, settings)

    assert result.valid
    assert any("orphan_file" in warning for warning in result.warnings)
    assert not (backup_path / "images" / "original" / orphan.name).exists()


@pytest.mark.parametrize("lifecycle_name", ["staging_dir", "purge_dir"])
def test_nonempty_lifecycle_state_refuses_backup(archive, lifecycle_name):
    settings, destination, _ = archive
    directory = getattr(settings, lifecycle_name)
    (directory / "interrupted").write_text("state", encoding="utf-8")

    with pytest.raises(BackupError, match="not empty"):
        create_backup(destination, settings)

    assert list(destination.iterdir()) == []


def test_lifecycle_state_appearing_before_publication_removes_temporary_backup(
    archive,
):
    settings, destination, _ = archive

    def interrupt_publication():
        (settings.staging_dir / "new-upload").write_text("active", encoding="utf-8")

    with pytest.raises(BackupError, match="not empty"):
        create_backup(destination, settings, before_publish=interrupt_publication)

    assert list(destination.iterdir()) == []


def test_changed_live_photo_inventory_refuses_publication(archive):
    settings, destination, _ = archive

    def mutate_inventory():
        connection = sqlite3.connect(settings.database_path)
        try:
            connection.execute(
                "UPDATE photo SET deleted_at = CURRENT_TIMESTAMP WHERE id = 1"
            )
            connection.commit()
        finally:
            connection.close()

    with pytest.raises(BackupError, match="changed before publication"):
        create_backup(destination, settings, before_publish=mutate_inventory)

    assert list(destination.iterdir()) == []


def test_missing_variant_and_database_hash_mismatch_are_fatal(archive):
    settings, destination, _ = archive
    missing = settings.image_dirs["thumbs"] / "photo-1_thumb.jpg"
    missing.unlink()
    with pytest.raises(BackupError, match="not a regular file"):
        create_backup(destination, settings)
    assert list(destination.iterdir()) == []

    missing.write_bytes(b"thumb-1")
    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute(
            "UPDATE photo SET content_sha256 = ? WHERE id = 1", ("0" * 64,)
        )
        connection.commit()
    finally:
        connection.close()
    with pytest.raises(BackupError, match="checksum disagrees"):
        create_backup(destination, settings)


def test_invalid_perceptual_hash_is_rejected_without_recomputing_images(archive):
    settings, destination, _ = archive
    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute(
            "UPDATE photo SET perceptual_hash = ? WHERE id = 1", ("NOT-A-HASH",)
        )
        connection.commit()
    finally:
        connection.close()

    with pytest.raises(
        BackupError, match=r"Invalid perceptual hash for photo id\(s\): 1"
    ):
        create_backup(destination, settings)


def test_unsafe_destination_and_stored_path_are_rejected(archive):
    settings, destination, _ = archive
    with pytest.raises(BackupError, match="overlaps"):
        create_backup(settings.image_dirs["original"], settings)

    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute(
            "UPDATE photo SET stored_filename = '../escape.jpg' WHERE id = 1"
        )
        connection.commit()
    finally:
        connection.close()
    with pytest.raises(BackupError, match="Unsafe stored image path"):
        create_backup(destination, settings)


def test_foreign_key_failure_and_unsupported_manifest_are_rejected(archive):
    settings, destination, _ = archive
    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("UPDATE photo SET animal_id = 999999 WHERE id = 1")
        connection.commit()
    finally:
        connection.close()
    with pytest.raises(BackupError, match="foreign_key_check"):
        create_backup(destination, settings)

    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute("UPDATE photo SET animal_id = 1 WHERE id = 1")
        connection.commit()
    finally:
        connection.close()
    backup_path, _ = create_backup(destination, settings)
    manifest_path = backup_path / "manifest.json"
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    payload["backup_format_version"] = 99
    manifest_path.write_text(json.dumps(payload), encoding="utf-8")
    result = verify_backup(backup_path)
    assert not result.valid
    assert any(
        "Unsupported backup format version: 99" in error for error in result.errors
    )


def test_cli_verify_reports_summary_without_source_paths(archive, capsys):
    settings, destination, _ = archive
    backup_path, _ = create_backup(destination, settings)

    exit_code = backup_main(["verify", str(backup_path)])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert "Status: VALID" in captured.out
    assert "Photos: 2 total, 1 active, 1 Trash" in captured.out
    assert str(settings.image_dir) not in captured.out


def test_source_symlink_is_rejected_when_supported(archive, tmp_path):
    settings, destination, _ = archive
    source = settings.image_dirs["original"] / "photo-1.jpg"
    target = tmp_path / "outside.jpg"
    target.write_bytes(source.read_bytes())
    source.unlink()
    try:
        source.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation is unavailable")

    with pytest.raises(BackupError, match="Symlink|regular file"):
        create_backup(destination, settings)
