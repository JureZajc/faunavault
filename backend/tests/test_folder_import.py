from __future__ import annotations

import asyncio
import hashlib
import os
from io import BytesIO
from pathlib import Path

import pytest
from PIL import ExifTags, Image, ImageDraw
from sqlmodel import Session, select

from app.cli import import_photos
from app.config import Settings
from app.database import create_database_engine
from app.models import ClassificationJob, Photo
from app.storage_startup import initialize_archive_storage
from tests.heic_fixtures import heic_bytes


def jpeg(seed: int, *, metadata: bool = False) -> bytes:
    image = Image.new("RGB", (80, 60), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((seed * 7, 4, seed * 7 + 12, 28), fill="blue")
    draw.ellipse((24, seed * 5, 57, seed * 5 + 25), fill="orange")
    exif = Image.Exif()
    if metadata:
        exif[int(ExifTags.Base.DateTimeOriginal)] = "2024:05:24 18:42:00"
        exif[int(ExifTags.Base.Make)] = "SONY"
    output = BytesIO()
    image.save(output, format="JPEG", exif=exif)
    return output.getvalue()


@pytest.fixture()
def archive(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        image_dir=tmp_path / "archive-images",
        database_url=f"sqlite:///{tmp_path / 'data' / 'faunavault.db'}",
        max_upload_bytes=1024 * 1024,
        max_image_pixels=1_000_000,
    )
    engine = create_database_engine(settings)
    initialize_archive_storage(engine, settings)
    engine.dispose()
    source = tmp_path / "source"
    source.mkdir()
    return settings, source


def run(source: Path, settings: Settings, **kwargs):
    return asyncio.run(import_photos.import_folder(source, settings, **kwargs))


def photos(settings: Settings) -> list[Photo]:
    engine = create_database_engine(settings)
    try:
        with Session(engine) as session:
            return list(session.exec(select(Photo).order_by(Photo.id)).all())
    finally:
        engine.dispose()


def test_nonrecursive_recursive_order_and_unsupported(archive, monkeypatch):
    settings, source = archive
    (source / "b.jpg").write_bytes(jpeg(2))
    (source / "a.jpg").write_bytes(jpeg(1))
    (source / "notes.txt").write_text("ignored")
    nested = source / "nested"
    nested.mkdir()
    (nested / "c.jpg").write_bytes(jpeg(3))
    order: list[str] = []
    original = import_photos.create_photo_from_source

    async def tracked(*args, **kwargs):
        order.append(args[2])
        return await original(*args, **kwargs)

    monkeypatch.setattr(import_photos, "create_photo_from_source", tracked)
    first = run(source, settings, allow_visual_duplicates=True)
    assert (first.scanned, first.imported, first.unsupported) == (3, 2, 1)
    assert order == ["a.jpg", "b.jpg"]
    second = run(source, settings, recursive=True, allow_visual_duplicates=True)
    assert (second.scanned, second.imported, second.duplicates) == (4, 1, 2)
    assert order[-3:] == ["a.jpg", "b.jpg", "c.jpg"]


def test_exact_duplicate_reimport_and_source_untouched(archive):
    settings, source = archive
    path = source / "animal.jpg"
    payload = jpeg(1)
    path.write_bytes(payload)
    before = path.stat()
    first = run(source, settings)
    second = run(source, settings)
    after = path.stat()
    assert (first.imported, second.duplicates, len(photos(settings))) == (1, 1, 1)
    assert path.read_bytes() == payload
    assert after.st_mtime_ns == before.st_mtime_ns
    assert after.st_size == before.st_size
    photo = photos(settings)[0]
    assert photo.content_sha256 == hashlib.sha256(payload).hexdigest()
    assert (
        settings.image_dirs["original"] / photo.stored_filename
    ).read_bytes() == payload
    assert (settings.image_dirs["resized"] / photo.resized_filename).is_file()
    assert (settings.image_dirs["thumbs"] / photo.thumbnail_filename).is_file()
    engine = create_database_engine(settings)
    try:
        with Session(engine) as session:
            assert list(session.exec(select(ClassificationJob)).all()) == []
    finally:
        engine.dispose()


def test_dry_run_simulates_duplicates_without_mutation(archive):
    settings, source = archive
    payload = jpeg(1)
    (source / "a.jpg").write_bytes(payload)
    (source / "b.jpg").write_bytes(payload)
    database = settings.database_path
    assert database is not None
    before = database.read_bytes()
    result = run(source, settings, dry_run=True, classify=True)
    assert (result.imported, result.duplicates, result.jobs) == (1, 1, 1)
    assert database.read_bytes() == before
    assert photos(settings) == []
    assert all(
        not any(directory.iterdir()) for directory in settings.image_dirs.values()
    )
    assert not any(settings.staging_dir.iterdir())


def test_metadata_heic_heif_and_classification_jobs(archive):
    settings, source = archive
    (source / "metadata.jpg").write_bytes(jpeg(1, metadata=True))
    (source / "phone.heic").write_bytes(heic_bytes("blue", metadata=True))
    (source / "phone.heif").write_bytes(heic_bytes("red", metadata=True))
    result = run(source, settings, classify=True, allow_visual_duplicates=True)
    assert (result.imported, result.jobs) == (3, 3)
    stored = photos(settings)
    assert len(stored) == 3
    assert all(photo.captured_at is not None for photo in stored)
    assert all(photo.status == "pending" for photo in stored)
    assert all(photo.perceptual_hash is not None for photo in stored)
    assert [photo.camera_make for photo in stored] == ["SONY", "Apple", "Apple"]
    assert all(photo.latitude is not None for photo in stored[1:])
    engine = create_database_engine(settings)
    try:
        with Session(engine) as session:
            jobs = list(session.exec(select(ClassificationJob)).all())
            assert len(jobs) == 3
            assert all(job.status == "queued" for job in jobs)
    finally:
        engine.dispose()


def test_visual_duplicate_gate_and_override(archive):
    settings, source = archive
    base = jpeg(1)
    image = Image.open(BytesIO(base))
    recompressed = BytesIO()
    image.save(recompressed, format="JPEG", quality=40)
    (source / "a.jpg").write_bytes(base)
    (source / "b.jpg").write_bytes(recompressed.getvalue())
    first = run(source, settings)
    assert (first.imported, first.visual_duplicates) == (1, 1)
    second = run(source, settings, allow_visual_duplicates=True)
    assert (second.duplicates, second.imported) == (1, 1)


def test_dry_run_reports_existing_and_prospective_visual_matches(archive):
    settings, source = archive
    base = jpeg(1)
    image = Image.open(BytesIO(base))
    near = BytesIO()
    image.save(near, format="JPEG", quality=40)
    (source / "a.jpg").write_bytes(base)
    (source / "b.jpg").write_bytes(near.getvalue())
    planned = run(source, settings, dry_run=True)
    assert (planned.imported, planned.visual_duplicates) == (1, 1)
    assert photos(settings) == []
    run(source, settings)
    existing = run(source, settings, dry_run=True)
    assert (existing.duplicates, existing.visual_duplicates) == (1, 1)


def test_corrupt_photo_continues_and_cleanup_on_job_failure(archive, monkeypatch):
    settings, source = archive
    (source / "a.jpg").write_bytes(b"corrupt")
    (source / "b.jpg").write_bytes(jpeg(1))
    first = run(source, settings)
    assert (first.failed, first.imported) == (1, 1)

    def fail_enqueue(*_args, **_kwargs):
        raise RuntimeError("injected job failure")

    monkeypatch.setattr(
        "app.services.photo_lifecycle.enqueue_classification_jobs", fail_enqueue
    )
    (source / "c.jpg").write_bytes(jpeg(2))
    second = run(source, settings, classify=True, allow_visual_duplicates=True)
    assert second.failed >= 1
    assert len(photos(settings)) == 1
    assert not any(settings.staging_dir.iterdir())
    assert all(
        len(list(directory.iterdir())) == 1
        for directory in settings.image_dirs.values()
    )


def test_import_rejects_archive_overlap_and_uninitialized_archive(archive):
    settings, source = archive
    with pytest.raises(import_photos.ImportSetupError, match="overlaps"):
        run(settings.image_dir.parent, settings)
    settings.database_path.unlink()
    with pytest.raises(import_photos.ImportSetupError, match="does not exist"):
        run(source, settings, dry_run=True)


def test_recursive_import_skips_directory_links(archive):
    settings, source = archive
    (source / "photo.jpg").write_bytes(jpeg(1))
    link = source / "loop"
    try:
        os.symlink(source, link, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"Directory links unavailable: {exc}")
    result = run(source, settings, recursive=True)
    assert (result.scanned, result.imported, result.unsupported) == (2, 1, 1)


def test_cli_summary_and_status_codes(archive, monkeypatch, capsys):
    settings, source = archive
    (source / "bad.jpg").write_bytes(b"broken")
    (source / "note.txt").write_text("skip")
    monkeypatch.setattr(import_photos, "get_settings", lambda: settings)
    assert import_photos.main([str(source)]) == 1
    output = capsys.readouterr().out
    assert "Failed: 1" in output
    assert "Unsupported: 1" in output
    assert import_photos.main([str(source), "--dry-run"]) == 1
    assert import_photos.main([str(source / "absent")]) == 2
