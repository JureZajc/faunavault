from __future__ import annotations

import asyncio
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageEnhance, ImageOps
from sqlmodel import Session, SQLModel, create_engine

import app.main as main
import app.services.photo_lifecycle as lifecycle_service
from app.config import Settings
from app.models import Photo, utc_now
from app.services.perceptual_duplicates import (
    find_visual_duplicate_candidates,
    hamming_distance,
    perceptual_hash,
    run_perceptual_hash_backfill,
)


def scene(shift: int = 0) -> Image.Image:
    image = Image.new("RGB", (640, 480), (205, 224, 196))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 300, 640, 480), fill=(98, 142, 76))
    draw.ellipse(
        (110 + shift, 80, 430 + shift, 380),
        fill=(176, 103, 56),
        outline=(60, 38, 20),
        width=8,
    )
    draw.ellipse(
        (320 + shift, 130, 500 + shift, 300),
        fill=(196, 126, 70),
        outline=(60, 38, 20),
        width=7,
    )
    draw.ellipse((405 + shift, 105, 445 + shift, 145), fill=(20, 20, 20))
    draw.polygon(
        [(475 + shift, 145), (590 + shift, 190), (480 + shift, 220)],
        fill=(40, 35, 25),
    )
    draw.line((40, 40, 600, 410), fill=(30, 60, 90), width=10)
    return image


def encoded(image: Image.Image, image_format: str = "JPEG", **kwargs) -> bytes:
    output = BytesIO()
    image.save(output, format=image_format, **kwargs)
    return output.getvalue()


def decoded(payload: bytes) -> Image.Image:
    image = Image.open(BytesIO(payload))
    image.load()
    return image


@pytest.fixture()
def perceptual_lifecycle(tmp_path, monkeypatch):
    database_path = tmp_path / "faunavault.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
        max_upload_bytes=5 * 1024 * 1024,
        max_image_pixels=2_000_000,
    )
    engine = create_engine(
        settings.resolved_database_url,
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "IMAGE_ROOT", settings.image_dir)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)
    monkeypatch.setattr(main, "DATABASE_PATH", database_path)

    def session_override():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    with TestClient(main.app) as client:
        yield client, engine, settings
    main.app.dependency_overrides.clear()


def post_image(
    client: TestClient,
    payload: bytes,
    filename: str = "photo.jpg",
    *,
    allow: bool = False,
):
    return client.post(
        "/photos/upload",
        files={"file": (filename, payload, "image/jpeg")},
        data={"allow_visual_duplicate": "true"} if allow else None,
    )


def test_phash_golden_vector_and_characterized_transformations():
    base = scene()
    base_hash = perceptual_hash(base)
    assert base_hash == "b8bb8385ef4a48b4"
    assert perceptual_hash(base.copy()) == base_hash

    variants = [
        decoded(encoded(base, quality=55)),
        base.resize((240, 180), Image.Resampling.LANCZOS).resize(
            base.size, Image.Resampling.LANCZOS
        ),
        decoded(encoded(base, "PNG")),
        ImageEnhance.Brightness(base).enhance(1.08),
        ImageEnhance.Contrast(base).enhance(0.9),
        base.crop((6, 5, 634, 475)).resize(base.size, Image.Resampling.LANCZOS),
    ]
    distances = [
        hamming_distance(base_hash, perceptual_hash(variant)) for variant in variants
    ]
    assert distances == [0, 0, 0, 0, 0, 4]
    assert hamming_distance(base_hash, perceptual_hash(scene(18))) > 4
    assert hamming_distance(base_hash, perceptual_hash(ImageOps.mirror(base))) > 4


def test_phash_normalizes_exif_orientation_and_transparency():
    base = scene()
    rotated = base.transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[274] = 6
    oriented = decoded(encoded(rotated, quality=95, exif=exif))
    assert hamming_distance(perceptual_hash(base), perceptual_hash(oriented)) == 0

    transparent = base.convert("RGBA")
    transparent.putalpha(255)
    assert perceptual_hash(transparent) == perceptual_hash(base)


def test_candidate_scan_is_bounded_ordered_and_skips_malformed_hashes(tmp_path, caplog):
    engine = create_engine(f"sqlite:///{tmp_path / 'candidates.db'}")
    SQLModel.metadata.create_all(engine)
    hashes = [
        ("0000000000000001", None),
        ("0000000000000000", utc_now()),
        ("0000000000000000", None),
        ("0000000000000007", None),
        ("malformed", None),
    ]
    with Session(engine) as session:
        for index, (value, deleted_at) in enumerate(hashes, start=1):
            session.add(
                Photo(
                    original_filename=f"photo-{index}.jpg",
                    stored_filename=f"photo-{index}.jpg",
                    resized_filename=f"photo-{index}-resized.jpg",
                    thumbnail_filename=f"photo-{index}-thumb.jpg",
                    perceptual_hash=value,
                    deleted_at=deleted_at,
                )
            )
        session.commit()
        candidates = find_visual_duplicate_candidates(session, "0000000000000000")

    assert [candidate.photo_id for candidate in candidates] == [3, 2, 1]
    assert [candidate.hamming_distance for candidate in candidates] == [0, 0, 1]
    assert "photo id 5" in caplog.text


def test_upload_warns_then_keeps_both_and_exact_still_wins(
    perceptual_lifecycle, monkeypatch
):
    client, engine, settings = perceptual_lifecycle
    original = encoded(scene(), quality=95)
    recompressed = encoded(decoded(original), quality=55)
    first = post_image(client, original, "fox-original.jpg")
    assert first.status_code == 200
    first_body = first.json()
    assert "perceptual_hash" not in first_body

    warning = post_image(client, recompressed, "fox-recompressed.jpg")
    assert warning.status_code == 409
    detail = warning.json()["detail"]
    assert detail["code"] == "possible_visual_duplicate"
    assert detail["candidates"][0]["photo_id"] == first_body["id"]
    assert detail["candidates"][0]["location"] == "catalog"
    assert "thumbnail_filename" not in detail["candidates"][0]
    assert not any(settings.staging_dir.iterdir())

    calls = 0
    original_scan = lifecycle_service.find_visual_duplicate_candidates

    def track_scan(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original_scan(*args, **kwargs)

    monkeypatch.setattr(
        lifecycle_service, "find_visual_duplicate_candidates", track_scan
    )
    kept = post_image(client, recompressed, "fox-recompressed.jpg", allow=True)
    assert kept.status_code == 200
    assert calls == 1
    with Session(engine) as session:
        stored = session.get(Photo, kept.json()["id"])
        assert stored is not None
        assert len(stored.perceptual_hash or "") == 16

    def fail_if_hashed(*_args, **_kwargs):
        raise AssertionError("exact duplicate must win before perceptual hashing")

    monkeypatch.setattr(lifecycle_service, "perceptual_hash_for_path", fail_if_hashed)
    exact = post_image(client, original, "renamed.jpg", allow=True)
    assert exact.status_code == 409
    assert exact.json()["detail"]["code"] == "duplicate_photo"


def test_trash_candidate_thumbnail_and_batch_results(perceptual_lifecycle):
    client, _, _ = perceptual_lifecycle
    original = encoded(scene(), quality=95)
    first = post_image(client, original, "fox.jpg").json()
    assert client.get(f"/photos/{first['id']}/thumbnail").status_code == 200
    assert client.delete(f"/photos/{first['id']}").status_code == 200
    assert client.get(f"/photos/{first['id']}/thumbnail").status_code == 200

    near = encoded(decoded(original), quality=60)
    different = encoded(ImageOps.mirror(scene()), quality=95)
    response = client.post(
        "/photos/upload-batch",
        files=[
            ("files", ("same-name.jpg", near, "image/jpeg")),
            ("files", ("same-name.jpg", different, "image/jpeg")),
            ("files", ("broken.jpg", b"broken", "image/jpeg")),
        ],
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["uploaded"]) == 1
    assert body["possible_duplicates"][0]["file_index"] == 0
    candidate = body["possible_duplicates"][0]["candidates"][0]
    assert candidate["location"] == "trash"
    assert "thumbnail_filename" not in candidate
    assert body["failed"][0]["file_index"] == 2
    assert client.get("/photos/999999/thumbnail").status_code == 404


def test_backfill_is_batched_yields_and_leaves_missing_original_null(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{tmp_path / 'backfill.db'}",
        max_image_pixels=2_000_000,
    )
    engine = create_engine(settings.resolved_database_url)
    SQLModel.metadata.create_all(engine)
    settings.image_dirs["original"].mkdir(parents=True)
    payload = encoded(scene())
    (settings.image_dirs["original"] / "present.jpg").write_bytes(payload)
    with Session(engine) as session:
        session.add_all(
            [
                Photo(
                    original_filename="present.jpg",
                    stored_filename="present.jpg",
                    resized_filename="present-resized.jpg",
                    thumbnail_filename="present-thumb.jpg",
                ),
                Photo(
                    original_filename="missing.jpg",
                    stored_filename="missing.jpg",
                    resized_filename="missing-resized.jpg",
                    thumbnail_filename="missing-thumb.jpg",
                ),
            ]
        )
        session.commit()

    pauses: list[float] = []

    async def record_pause(delay: float) -> None:
        pauses.append(delay)

    processed, skipped = asyncio.run(
        run_perceptual_hash_backfill(
            engine,
            settings,
            batch_size=1,
            pause_seconds=0.1,
            pause=record_pause,
        )
    )
    assert (processed, skipped) == (2, 1)
    assert pauses == [0.1, 0.1]
    with Session(engine) as session:
        present = session.get(Photo, 1)
        missing = session.get(Photo, 2)
        assert present is not None and present.perceptual_hash is not None
        assert missing is not None and missing.perceptual_hash is None
