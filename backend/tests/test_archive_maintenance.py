from __future__ import annotations

import hashlib
import io
import sqlite3
from pathlib import Path

import pytest
from PIL import Image
from sqlmodel import Session, SQLModel, create_engine

import app.services.archive_maintenance as maintenance_service
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.cli import maintenance as maintenance_cli
from app.config import Settings
from app.models import Animal, ClassificationJob, Photo, utc_now
from app.services.archive_maintenance import (
    MAINTENANCE_TEMP_PREFIX,
    MaintenanceSetupError,
    doctor,
    repair_derived,
)
from app.services.image_variants import (
    RESIZED_MAX_SIZE,
    THUMBNAIL_MAX_SIZE,
    save_variant,
)


def image_bytes(
    image_format: str = "JPEG",
    *,
    color: str = "green",
    size: tuple[int, int] = (80, 60),
) -> bytes:
    output = io.BytesIO()
    Image.new("RGB", size, color).save(output, format=image_format)
    return output.getvalue()


def add_photo(
    session: Session,
    settings: Settings,
    *,
    index: int,
    deleted: bool = False,
    image_format: str = "JPEG",
) -> Photo:
    extension = {"JPEG": "jpeg", "PNG": "png", "WEBP": "webp"}[image_format]
    media_type = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp"}[
        image_format
    ]
    payload = image_bytes(image_format, color="blue" if deleted else "green")
    original_name = f"photo-{index}.{extension}"
    resized_name = f"photo-{index}_resized.{extension}"
    thumbnail_name = f"photo-{index}_thumb.{extension}"
    original_path = settings.image_dirs["original"] / original_name
    original_path.write_bytes(payload)
    with Image.open(io.BytesIO(payload)) as image:
        save_variant(
            image,
            settings.image_dirs["resized"] / resized_name,
            extension,
            RESIZED_MAX_SIZE,
        )
        save_variant(
            image,
            settings.image_dirs["thumbs"] / thumbnail_name,
            extension,
            THUMBNAIL_MAX_SIZE,
        )
    animal = Animal(identifier=f"FV-MAINT-{index}")
    session.add(animal)
    session.flush()
    photo = Photo(
        original_filename=original_name,
        stored_filename=original_name,
        resized_filename=resized_name,
        thumbnail_filename=thumbnail_name,
        animal_id=animal.id,
        content_sha256=hashlib.sha256(payload).hexdigest(),
        original_size_bytes=len(payload),
        media_type=media_type,
        perceptual_hash=f"{index:016x}",
        deleted_at=utc_now() if deleted else None,
    )
    session.add(photo)
    session.flush()
    return photo


@pytest.fixture()
def archive(tmp_path):
    database_path = tmp_path / "archive" / "faunavault.db"
    image_root = tmp_path / "archive" / "images"
    database_path.parent.mkdir()
    settings = Settings(
        _env_file=None,
        data_dir=database_path.parent,
        image_dir=image_root,
        database_url=f"sqlite:///{database_path}",
        max_image_pixels=1_000_000,
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
        for version in range(1, 10):
            connection.exec_driver_sql(
                "INSERT INTO schema_migration VALUES (?, CURRENT_TIMESTAMP)",
                (version,),
            )
    with Session(engine) as session:
        active = add_photo(session, settings, index=1)
        trashed = add_photo(session, settings, index=2, deleted=True)
        session.commit()
        active_id = active.id
        trashed_id = trashed.id
    yield settings, engine, active_id, trashed_id
    engine.dispose()


def finding_codes(result) -> set[str]:
    return {finding.code for finding in result.findings}


def test_doctor_reports_healthy_active_and_trash_archive(archive):
    settings, _, _, _ = archive

    result = doctor(settings)

    assert result.status == "HEALTHY"
    assert result.inventory is not None
    assert result.inventory.active_photos == 1
    assert result.inventory.trashed_photos == 1
    assert result.healthy_counts == {"original": 2, "resized": 2, "thumbs": 2}
    assert result.findings == []


@pytest.mark.parametrize(
    ("extension", "expected_format", "expected_kwargs", "expected_mode"),
    [
        ("jpeg", "JPEG", {"quality": 88, "optimize": True}, "RGB"),
        ("webp", "WEBP", {"quality": 88, "optimize": True}, "RGBA"),
        ("png", "PNG", {}, "RGBA"),
    ],
)
def test_shared_variant_save_semantics(
    tmp_path,
    monkeypatch,
    extension,
    expected_format,
    expected_kwargs,
    expected_mode,
):
    captured = {}

    def capture_save(image, path, *, format, **kwargs):
        captured.update(
            mode=image.mode,
            size=image.size,
            path=path,
            format=format,
            kwargs=kwargs,
        )

    monkeypatch.setattr(Image.Image, "save", capture_save)
    source = Image.new("RGBA", (2000, 1000), (255, 0, 0, 128))

    save_variant(source, tmp_path / "variant.tmp", extension, (1600, 1600))

    assert captured == {
        "mode": expected_mode,
        "size": (1600, 800),
        "path": tmp_path / "variant.tmp",
        "format": expected_format,
        "kwargs": expected_kwargs,
    }


def test_dry_run_and_apply_repair_only_broken_active_and_trash_variants(archive):
    settings, _, _, _ = archive
    missing = settings.image_dirs["resized"] / "photo-1_resized.jpeg"
    corrupt = settings.image_dirs["thumbs"] / "photo-2_thumb.jpeg"
    healthy_sibling = settings.image_dirs["thumbs"] / "photo-1_thumb.jpeg"
    missing.unlink()
    corrupt.write_bytes(b"not an image")
    original_before = {
        path: path.read_bytes() for path in settings.image_dirs["original"].iterdir()
    }
    database_before = settings.database_path.read_bytes()
    sibling_before = (healthy_sibling.read_bytes(), healthy_sibling.stat().st_mtime_ns)

    dry_run = repair_derived(settings)

    assert dry_run.health.status == "NEEDS_REPAIR"
    assert finding_codes(dry_run.health) >= {"resized_missing", "thumbnail_corrupt"}
    assert not missing.exists()
    assert corrupt.read_bytes() == b"not an image"
    assert not any(
        path.name.startswith(MAINTENANCE_TEMP_PREFIX)
        for role in ("resized", "thumbs")
        for path in settings.image_dirs[role].iterdir()
    )

    applied = repair_derived(settings, apply=True)

    assert applied.repaired == 2
    assert applied.failed == 0
    assert applied.health.status == "HEALTHY"
    for path, payload in original_before.items():
        assert path.read_bytes() == payload
    assert settings.database_path.read_bytes() == database_before
    assert (
        healthy_sibling.read_bytes(),
        healthy_sibling.stat().st_mtime_ns,
    ) == sibling_before
    with Image.open(missing) as image:
        assert image.format == "JPEG"
        assert image.width <= 1600 and image.height <= 1600
    with Image.open(corrupt) as image:
        assert image.format == "JPEG"
        assert image.width <= 480 and image.height <= 480


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        ("missing", "original_missing"),
        ("sha", "original_sha_mismatch"),
        ("size", "original_size_mismatch"),
        ("corrupt", "original_corrupt"),
        ("format", "original_wrong_format"),
        ("pixels", "original_pixel_limit"),
        ("unsafe", "original_unsafe_path"),
    ],
)
def test_original_failures_are_errors_and_never_repair_sources(
    archive, mutation, expected_code
):
    settings, _, active_id, _ = archive
    original = settings.image_dirs["original"] / "photo-1.jpeg"
    connection = sqlite3.connect(settings.database_path)
    try:
        if mutation == "missing":
            original.unlink()
        elif mutation == "sha":
            connection.execute(
                "UPDATE photo SET content_sha256 = ? WHERE id = ?",
                ("0" * 64, active_id),
            )
        elif mutation == "size":
            connection.execute(
                "UPDATE photo SET original_size_bytes = original_size_bytes + 1 "
                "WHERE id = ?",
                (active_id,),
            )
        elif mutation == "corrupt":
            original.write_bytes(b"broken")
        elif mutation == "format":
            original.write_bytes(image_bytes("PNG"))
        elif mutation == "pixels":
            payload = image_bytes(size=(1100, 1000))
            original.write_bytes(payload)
            connection.execute(
                "UPDATE photo SET content_sha256 = ?, original_size_bytes = ? "
                "WHERE id = ?",
                (hashlib.sha256(payload).hexdigest(), len(payload), active_id),
            )
        else:
            connection.execute(
                "UPDATE photo SET stored_filename = '../escape.jpeg' WHERE id = ?",
                (active_id,),
            )
        connection.commit()
    finally:
        connection.close()

    result = doctor(settings)

    assert result.status == "UNHEALTHY"
    assert expected_code in finding_codes(result)
    assert all(candidate.photo.id != active_id for candidate in result.candidates)


@pytest.mark.parametrize(
    ("role", "filename", "payload", "expected_code"),
    [
        ("resized", "photo-1_resized.jpeg", None, "resized_missing"),
        ("thumbs", "photo-1_thumb.jpeg", None, "thumbnail_missing"),
        ("resized", "photo-1_resized.jpeg", b"broken", "resized_corrupt"),
        ("thumbs", "photo-1_thumb.jpeg", b"broken", "thumbnail_corrupt"),
        (
            "resized",
            "photo-1_resized.jpeg",
            image_bytes("PNG"),
            "resized_wrong_format",
        ),
        (
            "thumbs",
            "photo-1_thumb.jpeg",
            image_bytes("PNG"),
            "thumbnail_wrong_format",
        ),
        (
            "resized",
            "photo-1_resized.jpeg",
            image_bytes(size=(1601, 1)),
            "resized_oversized",
        ),
        (
            "thumbs",
            "photo-1_thumb.jpeg",
            image_bytes(size=(481, 1)),
            "thumbnail_oversized",
        ),
    ],
)
def test_doctor_detects_derivative_failures_independently(
    archive, role, filename, payload, expected_code
):
    settings, _, _, _ = archive
    path = settings.image_dirs[role] / filename
    if payload is None:
        path.unlink()
    else:
        path.write_bytes(payload)

    result = doctor(settings)

    assert result.status == "NEEDS_REPAIR"
    assert expected_code in finding_codes(result)
    assert len(result.candidates) == 1


def test_warnings_orphans_temps_and_running_job_do_not_make_archive_unhealthy(archive):
    settings, engine, active_id, _ = archive
    (settings.image_dirs["original"] / "orphan.jpeg").write_bytes(b"orphan")
    (settings.image_dirs["thumbs"] / f"{MAINTENANCE_TEMP_PREFIX}stale.tmp").write_bytes(
        b"stale"
    )
    with Session(engine) as session:
        photo = session.get(Photo, active_id)
        session.add(
            ClassificationJob(
                photo_id=active_id,
                status="running",
                batch_id="maintenance-test",
                batch_kind="single",
                requested_model="test",
                prompt_version="v1",
                source_photo_updated_at=photo.updated_at,
            )
        )
        session.commit()

    result = doctor(settings)

    assert result.status == "HEALTHY"
    assert finding_codes(result) >= {
        "orphan_file",
        "maintenance_temp",
        "running_classification_jobs",
    }


def test_inventory_case_collisions_and_malformed_hashes_are_errors(archive):
    settings, _, _, trashed_id = archive
    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute(
            "UPDATE photo SET resized_filename = 'PHOTO-1_RESIZED.JPEG' WHERE id = ?",
            (trashed_id,),
        )
        connection.commit()
    finally:
        connection.close()
    collision = doctor(settings)
    assert collision.status == "UNHEALTHY"
    assert "resized_case_collision" in finding_codes(collision)

    connection = sqlite3.connect(settings.database_path)
    try:
        connection.execute(
            "UPDATE photo SET resized_filename = 'photo-2_resized.jpeg', "
            "perceptual_hash = 'NOT-A-HASH' WHERE id = ?",
            (trashed_id,),
        )
        connection.commit()
    finally:
        connection.close()
    malformed = doctor(settings)
    assert malformed.status == "UNHEALTHY"
    assert "database_invalid" in finding_codes(malformed)


def test_lifecycle_and_concurrent_inventory_changes_fail_safely(archive):
    settings, _, active_id, _ = archive
    (settings.staging_dir / "active-upload").write_text("state", encoding="utf-8")
    blocked = doctor(settings)
    assert blocked.status == "UNHEALTHY"
    assert "lifecycle_state" in finding_codes(blocked)
    (settings.staging_dir / "active-upload").unlink()

    def mutate_inventory():
        connection = sqlite3.connect(settings.database_path)
        try:
            connection.execute(
                "UPDATE photo SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
                (active_id,),
            )
            connection.commit()
        finally:
            connection.close()

    changed = doctor(settings, before_finish=mutate_inventory)
    assert changed.status == "UNHEALTHY"
    assert "archive_changed" in finding_codes(changed)


def test_atomic_replace_failure_preserves_existing_derivative_and_cleans_temp(archive):
    settings, _, _, _ = archive
    target = settings.image_dirs["resized"] / "photo-1_resized.jpeg"
    target.write_bytes(b"corrupt-but-preserved")

    def fail_replace(_source: Path, _target: Path) -> None:
        raise OSError("simulated sharing violation")

    result = repair_derived(settings, apply=True, replace=fail_replace)

    assert result.failed == 1
    assert result.health.status == "UNHEALTHY"
    assert target.read_bytes() == b"corrupt-but-preserved"
    assert not any(
        path.name.startswith(MAINTENANCE_TEMP_PREFIX)
        for path in settings.image_dirs["resized"].iterdir()
    )


def test_render_failure_isolated_and_rerun_is_idempotent(archive, monkeypatch):
    settings, _, _, _ = archive
    target = settings.image_dirs["thumbs"] / "photo-1_thumb.jpeg"
    target.unlink()

    def fail_render(*_args, **_kwargs):
        raise OSError("simulated render failure")

    monkeypatch.setattr("app.services.archive_maintenance.save_variant", fail_render)
    failed = repair_derived(settings, apply=True)
    assert failed.failed == 1
    assert not target.exists()
    assert not any(
        path.name.startswith(MAINTENANCE_TEMP_PREFIX)
        for path in settings.image_dirs["thumbs"].iterdir()
    )

    monkeypatch.undo()
    repaired = repair_derived(settings, apply=True)
    assert repaired.repaired == 1
    assert repaired.health.status == "HEALTHY"
    again = repair_derived(settings, apply=True)
    assert again.repaired == 0
    assert again.health.status == "HEALTHY"


def test_target_change_is_not_overwritten(archive, monkeypatch):
    settings, _, _, _ = archive
    target = settings.image_dirs["thumbs"] / "photo-1_thumb.jpeg"
    target.unlink()
    original_read = maintenance_service.read_photo_record
    changed = False

    def change_target_before_row_check(database: Path, photo_id: int):
        nonlocal changed
        if not changed:
            target.write_bytes(b"concurrently changed")
            changed = True
        return original_read(database, photo_id)

    monkeypatch.setattr(
        maintenance_service, "read_photo_record", change_target_before_row_check
    )

    result = repair_derived(settings, apply=True)

    assert result.repaired == 0
    assert result.failed == 1
    assert target.read_bytes() == b"concurrently changed"
    assert "repair_target_changed" in finding_codes(result.health)


def test_bad_original_does_not_block_unrelated_safe_repair(archive):
    settings, _, _, _ = archive
    repairable = settings.image_dirs["resized"] / "photo-1_resized.jpeg"
    repairable.unlink()
    bad_original = settings.image_dirs["original"] / "photo-2.jpeg"
    bad_original.write_bytes(b"corrupt original")
    bad_derivative = settings.image_dirs["thumbs"] / "photo-2_thumb.jpeg"
    bad_derivative.unlink()

    result = repair_derived(settings, apply=True)

    assert result.repaired == 1
    assert result.health.status == "UNHEALTHY"
    assert repairable.is_file()
    assert not bad_derivative.exists()
    assert "original_corrupt" in finding_codes(result.health)


def test_repaired_archive_can_be_backed_up_and_verified(archive, tmp_path):
    settings, _, _, _ = archive
    (settings.image_dirs["thumbs"] / "photo-1_thumb.jpeg").unlink()
    repaired = repair_derived(settings, apply=True)
    destination = tmp_path / "backups"
    destination.mkdir()

    backup_path, created = create_backup(destination, settings)

    assert repaired.health.status == "HEALTHY"
    assert created.valid
    assert verify_backup(backup_path).valid


def test_cli_exit_codes_and_output(archive, monkeypatch, capsys, tmp_path):
    settings, _, _, _ = archive
    monkeypatch.setattr(maintenance_cli, "get_settings", lambda: settings)
    assert maintenance_cli.main(["doctor"]) == 0
    assert "Status: HEALTHY" in capsys.readouterr().out

    (settings.image_dirs["thumbs"] / "photo-1_thumb.jpeg").unlink()
    assert maintenance_cli.main(["repair-derived"]) == 1
    output = capsys.readouterr().out
    assert "REPAIR thumbnail_missing" in output
    assert "No files were changed" in output

    missing = Settings(
        _env_file=None,
        image_dir=tmp_path / "missing-images",
        database_url=f"sqlite:///{tmp_path / 'missing.db'}",
    )
    monkeypatch.setattr(maintenance_cli, "get_settings", lambda: missing)
    assert maintenance_cli.main(["doctor"]) == 2
    assert "could not start" in capsys.readouterr().err


def test_configured_storage_links_are_rejected_when_supported(archive, tmp_path):
    settings, _, _, _ = archive
    link = tmp_path / "linked-images"
    try:
        link.symlink_to(settings.image_dir, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    linked_settings = Settings(
        _env_file=None,
        image_dir=link,
        database_url=settings.database_url,
    )

    with pytest.raises(MaintenanceSetupError, match="link or junction"):
        doctor(linked_settings)
