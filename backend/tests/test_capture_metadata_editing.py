from __future__ import annotations

import json
import sqlite3
from io import BytesIO

import pytest
from PIL import ExifTags, Image
from sqlalchemy import update
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

import app.main as main
import app.services.photo_metadata_backfill as backfill_module
from app.archive_export.service import create_metadata_export
from app.archive_integrity import ArchiveIntegrityError, inspect_database
from app.backup.rehearsal import rehearse_backup
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.migrations import run_migrations
from app.models import Photo, utc_now
from app.services.photo_metadata_backfill import backfill_photo_metadata
from tests.heic_fixtures import heic_bytes
from tests.test_photo_lifecycle import lifecycle as lifecycle
from tests.test_photo_lifecycle import metadata_jpeg_bytes, upload


def patch(client, photo, **metadata):
    return client.patch(
        f"/photos/{photo['id']}",
        params={"expected_updated_at": photo["updated_at"]},
        json=metadata,
    )


def gps_metadata_jpeg_bytes():
    with Image.open(BytesIO(metadata_jpeg_bytes())) as image:
        exif = image.getexif()
        exif[int(ExifTags.IFD.GPSInfo)] = {1: "N", 2: (46, 0, 0), 3: "E", 4: (14, 0, 0)}
        output = BytesIO()
        image.save(output, format="JPEG", exif=exif)
        return output.getvalue()


@pytest.mark.parametrize("offset", [None, -1439, -330, 0, 120, 1439])
def test_capture_add_edit_clear_and_review_state(lifecycle, offset):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    original = settings.image_dirs["original"] / photo["stored_filename"]
    original_bytes = original.read_bytes()
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        stored.status = "needs_review"
        session.add(stored)
        session.commit()
    photo = client.get(f"/photos/{photo['id']}").json()
    added = patch(
        client,
        photo,
        captured_at="2025-01-02T23:59:59.123456",
        captured_at_offset_minutes=offset,
    )
    assert added.status_code == 200
    added = added.json()
    assert added["captured_at"] == "2025-01-02T23:59:59.123456"
    assert added["captured_at_offset_minutes"] == offset
    assert added["capture_metadata_overridden"]
    assert added["extracted_captured_at"] is None
    assert added["status"] == "needs_review" and added["reviewed_at"] is None
    repeated = patch(
        client,
        added,
        captured_at=added["captured_at"],
        captured_at_offset_minutes=offset,
    ).json()
    assert repeated["updated_at"] == added["updated_at"]
    changed = patch(
        client,
        added,
        captured_at="2026-02-03T01:02:03",
        captured_at_offset_minutes=None,
    ).json()
    assert changed["captured_at_offset_minutes"] is None
    cleared = patch(
        client, changed, captured_at=None, captured_at_offset_minutes=None
    ).json()
    assert cleared["captured_at"] is None and cleared["capture_metadata_overridden"]
    assert original.read_bytes() == original_bytes


def test_explicit_unchanged_values_establish_manual_authority(lifecycle):
    client, _, _ = lifecycle
    photo = upload(client, gps_metadata_jpeg_bytes()).json()
    updated = patch(
        client,
        photo,
        **{
            name: photo[name]
            for name in (
                "captured_at",
                "captured_at_offset_minutes",
                "latitude",
                "longitude",
            )
        },
    ).json()
    assert (
        updated["capture_metadata_overridden"]
        and updated["location_metadata_overridden"]
    )
    assert updated["updated_at"] != photo["updated_at"]
    for name in ("captured_at", "captured_at_offset_minutes", "latitude", "longitude"):
        assert (
            updated[f"extracted_{name}"] == photo[f"extracted_{name}"] == updated[name]
        )


def test_restore_legacy_original_without_recorded_hash_or_size(lifecycle):
    client, engine, _ = lifecycle
    photo = upload(client, metadata_jpeg_bytes()).json()
    photo = patch(
        client, photo, captured_at=None, captured_at_offset_minutes=None
    ).json()
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        stored.content_sha256 = None
        stored.original_size_bytes = None
        session.add(stored)
        session.commit()
    restored = patch(client, photo, restore_original_metadata=True)
    assert restored.status_code == 200
    assert restored.json()["captured_at"] == "2024-05-24T18:42:00"
    assert not restored.json()["capture_metadata_overridden"]


def test_restore_rejects_original_link_even_when_target_identity_matches(lifecycle):
    client, _, settings = lifecycle
    photo = upload(client, metadata_jpeg_bytes()).json()
    photo = patch(
        client, photo, captured_at=None, captured_at_offset_minutes=None
    ).json()
    original = settings.image_dirs["original"] / photo["stored_filename"]
    target = original.with_name("linked-copy.jpg")
    original.rename(target)
    try:
        original.symlink_to(target)
    except OSError:
        pytest.skip("Creating file symlinks is not permitted on this platform")
    assert patch(client, photo, restore_original_metadata=True).status_code == 422
    assert client.get(f"/photos/{photo['id']}").json() == photo


@pytest.mark.parametrize(
    "metadata",
    [
        {"captured_at": "2025-01-02T03:04:05"},
        {"captured_at_offset_minutes": 120},
        {"captured_at": "2025-01-02", "captured_at_offset_minutes": None},
        {"captured_at": 12345, "captured_at_offset_minutes": None},
        {"captured_at": "2025-02-30T03:04:05", "captured_at_offset_minutes": None},
        {"captured_at": "2025-01-02T03:04:05Z", "captured_at_offset_minutes": 0},
        {"captured_at": "2025-01-02T03:04:05+02:00", "captured_at_offset_minutes": 120},
        {"captured_at": None, "captured_at_offset_minutes": 120},
        {"captured_at": "2025-01-02T03:04:05", "captured_at_offset_minutes": 1440},
        {"captured_at": "2025-01-02T03:04:05", "captured_at_offset_minutes": 1.5},
        {"captured_at": "2025-01-02T03:04:05", "captured_at_offset_minutes": True},
        {"latitude": 1},
        {"longitude": 1},
        {"latitude": None, "longitude": 1},
        {"latitude": 91, "longitude": 0},
        {"latitude": 0, "longitude": -181},
        {"latitude": "NaN", "longitude": 1},
        {"latitude": "1", "longitude": 1},
        {"latitude": True, "longitude": 1},
        {"extracted_captured_at": None},
        {"capture_metadata_overridden": False},
        {"location_metadata_overridden": False},
        {"extracted_latitude": 1},
        {"restore_original_metadata": True, "latitude": None, "longitude": None},
        {"restore_original_metadata": "true"},
    ],
)
def test_invalid_capture_patch_is_atomic(lifecycle, metadata):
    client, _, _ = lifecycle
    photo = upload(client).json()
    response = patch(client, photo, display_title="Must not save", **metadata)
    assert response.status_code == 422
    assert client.get(f"/photos/{photo['id']}").json() == photo


@pytest.mark.parametrize("coordinate", ["NaN", "Infinity", "-Infinity"])
def test_nonfinite_json_coordinates_rejected(lifecycle, coordinate):
    client, _, _ = lifecycle
    photo = upload(client).json()
    response = client.patch(
        f"/photos/{photo['id']}",
        params={"expected_updated_at": photo["updated_at"]},
        content=f'{{"latitude":{coordinate},"longitude":0}}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422


def test_effective_metadata_drives_all_browsing_and_trash(lifecycle):
    client, _, settings = lifecycle
    first = upload(client, metadata_jpeg_bytes()).json()
    second = client.post(
        "/photos/upload",
        data={"allow_visual_duplicate": "true"},
        files={
            "file": ("second.jpg", metadata_jpeg_bytes() + b"different", "image/jpeg")
        },
    ).json()
    source_bytes = (
        settings.image_dirs["original"] / first["stored_filename"]
    ).read_bytes()
    collection = client.post(
        "/smart-collections",
        json={
            "name": "January",
            "query_version": 1,
            "query": {"taken_from": "2026-01-01", "taken_to": "2026-01-31"},
        },
    ).json()
    path = f"/smart-collections/{collection['id']}/photos"
    assert client.get(path).json()["total"] == 0
    first = patch(
        client,
        first,
        captured_at="2026-01-02T03:04:05",
        captured_at_offset_minutes=-600,
        latitude=90,
        longitude=-180,
    ).json()
    assert first["extracted_captured_at"] == "2024-05-24T18:42:00"
    assert first["extracted_captured_at_offset_minutes"] == 120
    assert client.get(path).json()["total"] == 1
    assert client.get("/catalog/timeline").json()["years"][0]["year"] == 2026
    assert client.get("/catalog/timeline").json()["years"][0]["months"][0]["month"] == 1
    assert client.get("/catalog/map").json()[0]["latitude"] == 90
    first = patch(client, first, latitude=0, longitude=0).json()
    assert client.get("/catalog/map").json()[0]["longitude"] == 0
    second = patch(
        client,
        second,
        captured_at="2026-01-03T01:00:00",
        captured_at_offset_minutes=None,
    ).json()
    ascending = client.get(
        "/catalog/photos", params={"sort": "captured_at", "order": "asc"}
    ).json()
    assert [p["id"] for p in ascending["items"]] == [first["id"], second["id"]]
    assert (
        client.get("/catalog/photos", params={"taken_from": "2026-01-03"}).json()[
            "total"
        ]
        == 1
    )
    first = patch(
        client,
        first,
        captured_at="2027-02-01T00:00:00",
        captured_at_offset_minutes=None,
    ).json()
    assert client.get(path).json()["total"] == 1  # second remains in January
    assert client.get("/catalog/timeline").json()["years"][0]["months"][0]["month"] == 2
    first = patch(
        client,
        first,
        captured_at=None,
        captured_at_offset_minutes=None,
        latitude=None,
        longitude=None,
    ).json()
    assert client.get("/catalog/timeline").json()["unknown_capture_count"] == 1
    assert client.get("/catalog/map").json() == []
    assert client.delete(f"/photos/{first['id']}").status_code == 200
    assert client.get("/catalog/timeline").json()["unknown_capture_count"] == 0
    backfill_photo_metadata(settings, apply=True)
    assert client.post(f"/trash/photos/{first['id']}/restore").status_code == 200
    restored = client.get(f"/photos/{first['id']}").json()
    assert restored["captured_at"] is None and restored["latitude"] is None
    assert (
        restored["capture_metadata_overridden"]
        and restored["location_metadata_overridden"]
    )
    assert (
        settings.image_dirs["original"] / first["stored_filename"]
    ).read_bytes() == source_bytes


def test_backfill_preserves_manual_values_and_clears(lifecycle):
    client, engine, settings = lifecycle
    photo = upload(client, gps_metadata_jpeg_bytes()).json()
    photo = patch(
        client,
        photo,
        captured_at="2026-01-02T03:04:05",
        captured_at_offset_minutes=None,
        latitude=46.123456789,
        longitude=14.987654321,
    ).json()
    # Simulate a legacy row whose retained extraction has yet to be populated.
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        stored.extracted_captured_at = None
        stored.extracted_captured_at_offset_minutes = None
        session.add(stored)
        session.commit()
    assert backfill_photo_metadata(settings).updated == 1
    assert backfill_photo_metadata(settings, apply=True).updated == 1
    stored = client.get(f"/photos/{photo['id']}").json()
    assert (
        stored["captured_at"] == photo["captured_at"]
        and stored["latitude"] == photo["latitude"]
    )
    assert stored["extracted_captured_at"] == "2024-05-24T18:42:00"
    assert stored["extracted_latitude"] == 46 and stored["extracted_longitude"] == 14
    cleared = patch(
        client,
        stored,
        captured_at=None,
        captured_at_offset_minutes=None,
        latitude=None,
        longitude=None,
    ).json()
    assert backfill_photo_metadata(settings, apply=True).updated == 0
    assert client.get(f"/photos/{photo['id']}").json() == cleared


def test_backfill_rejects_a_manual_edit_after_extraction(lifecycle, monkeypatch):
    client, engine, settings = lifecycle
    photo = upload(client, metadata_jpeg_bytes()).json()
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        stored.captured_at = None
        stored.captured_at_offset_minutes = None
        session.add(stored)
        session.commit()
    extract = backfill_module.extract_photo_metadata

    def concurrent_extract(image):
        result = extract(image)
        current = client.get(f"/photos/{photo['id']}").json()
        assert (
            patch(
                client, current, captured_at=None, captured_at_offset_minutes=None
            ).status_code
            == 200
        )
        return result

    monkeypatch.setattr(backfill_module, "extract_photo_metadata", concurrent_extract)
    result = backfill_photo_metadata(settings, apply=True)
    assert result.updated == 0 and result.skipped == 1
    current = client.get(f"/photos/{photo['id']}").json()
    assert current["captured_at"] is None and current["capture_metadata_overridden"]


@pytest.mark.parametrize(
    "source", ["none", "date", "gps", "offsetless", "complete", "heic"]
)
def test_restore_reextracts_supported_original_groups(lifecycle, source):
    client, _, settings = lifecycle
    if source == "heic":
        photo = client.post(
            "/photos/upload",
            files={"file": ("capture.heic", heic_bytes(metadata=True), "image/heic")},
        ).json()
    else:
        exif = Image.Exif()
        if source in ("date", "offsetless", "complete"):
            exif[int(ExifTags.Base.DateTimeOriginal)] = "2024:05:24 18:42:00"
        if source == "complete":
            exif[int(ExifTags.Base.OffsetTimeOriginal)] = "+02:00"
        if source in ("gps", "complete"):
            exif[int(ExifTags.IFD.GPSInfo)] = {
                1: "N",
                2: (46, 0, 0),
                3: "E",
                4: (14, 0, 0),
            }
        data = BytesIO()
        Image.new("RGB", (48, 32), "green").save(data, format="JPEG", exif=exif)
        photo = upload(client, data.getvalue()).json()
    original = settings.image_dirs["original"] / photo["stored_filename"]
    before = original.read_bytes()
    manual = patch(
        client,
        photo,
        captured_at="2026-02-03T01:02:03",
        captured_at_offset_minutes=-60,
        latitude=-90,
        longitude=180,
    ).json()
    restored = patch(client, manual, restore_original_metadata=True)
    assert restored.status_code == 200
    restored = restored.json()
    for name in ("captured_at", "captured_at_offset_minutes", "latitude", "longitude"):
        assert restored[name] == photo[name] == restored[f"extracted_{name}"]
    assert (
        not restored["capture_metadata_overridden"]
        and not restored["location_metadata_overridden"]
    )
    assert original.read_bytes() == before


@pytest.mark.parametrize(
    "failure",
    ["missing", "changed", "corrupt", "pixel_limit", "size", "media_type", "unstable"],
)
def test_restore_failure_preserves_entire_patch(lifecycle, monkeypatch, failure):
    client, engine, settings = lifecycle
    photo = upload(client, metadata_jpeg_bytes()).json()
    original = settings.image_dirs["original"] / photo["stored_filename"]
    if failure == "missing":
        original.unlink()
    elif failure == "changed":
        original.write_bytes(original.read_bytes() + b"changed")
    elif failure == "corrupt":
        original.write_bytes(b"not an image")
        with Session(engine) as session:
            stored = session.get(Photo, photo["id"])
            stored.content_sha256 = None
            stored.original_size_bytes = None
            session.add(stored)
            session.commit()
        photo = client.get(f"/photos/{photo['id']}").json()
    elif failure == "pixel_limit":
        monkeypatch.setattr(settings, "max_image_pixels", 1)
    elif failure in ("size", "media_type"):
        with Session(engine) as session:
            stored = session.get(Photo, photo["id"])
            setattr(
                stored,
                "original_size_bytes" if failure == "size" else "media_type",
                1 if failure == "size" else "image/png",
            )
            session.add(stored)
            session.commit()
        photo = client.get(f"/photos/{photo['id']}").json()
    else:
        import app.services.capture_metadata as capture_module

        monkeypatch.setattr(capture_module, "file_identity", lambda path: None)
    response = patch(
        client, photo, display_title="Must not save", restore_original_metadata=True
    )
    assert response.status_code == 422
    assert client.get(f"/photos/{photo['id']}").json() == photo


@pytest.mark.parametrize(
    "change", [{"latitude": 2, "longitude": 2}, {"restore_original_metadata": True}]
)
def test_required_version_stale_and_compare_and_swap(lifecycle, monkeypatch, change):
    client, engine, _ = lifecycle
    photo = upload(client).json()
    assert (
        client.patch(
            f"/photos/{photo['id']}", json={"latitude": 1, "longitude": 1}
        ).status_code
        == 422
    )
    updated = patch(client, photo, latitude=1, longitude=1).json()
    assert patch(client, photo, latitude=2, longitude=2).status_code == 409
    # Race after initial version validation, before the conditional UPDATE.
    original_update = main.update

    def concurrent_update(model):
        with engine.begin() as connection:
            connection.execute(
                update(Photo)
                .where(Photo.id == photo["id"])
                .values(updated_at=utc_now(), latitude=3, longitude=3)
            )
        return original_update(model)

    monkeypatch.setattr(main, "update", concurrent_update)
    assert patch(client, updated, **change).status_code == 409
    assert client.get(f"/photos/{photo['id']}").json()["latitude"] == 3


def test_commit_failure_rolls_back_metadata(lifecycle, monkeypatch):
    client, _, _ = lifecycle
    photo = upload(client).json()

    def fail_commit(session):
        raise SQLAlchemyError("simulated commit failure")

    with monkeypatch.context() as patcher:
        patcher.setattr(Session, "commit", fail_commit)
        with pytest.raises(SQLAlchemyError):
            patch(client, photo, latitude=1, longitude=1)
    assert client.get(f"/photos/{photo['id']}").json() == photo


def test_schema15_backups_rehearsal_and_portable_export(lifecycle, tmp_path_factory):
    artifact_root = tmp_path_factory.mktemp("capture-artifacts")
    client, _, settings = lifecycle
    photo = upload(client, metadata_jpeg_bytes()).json()
    photo = patch(
        client,
        photo,
        captured_at=None,
        captured_at_offset_minutes=None,
        latitude=46.123456789,
        longitude=14.123456789,
    ).json()
    other = client.post(
        "/photos/upload",
        data={"allow_visual_duplicate": "true"},
        files={
            "file": ("other.jpg", metadata_jpeg_bytes() + b"different", "image/jpeg")
        },
    ).json()
    other = patch(
        client,
        other,
        captured_at="2026-01-02T03:04:05",
        captured_at_offset_minutes=60,
        latitude=None,
        longitude=None,
    ).json()
    client.delete(f"/photos/{other['id']}")
    (artifact_root / "backups").mkdir()
    backup, verification = create_backup(artifact_root / "backups", settings)
    assert verification.valid and verify_backup(backup).valid
    result = rehearse_backup(backup, artifact_root / "recovered")
    assert result.source_schema_version == 18 and result.doctor_status == "HEALTHY"
    with sqlite3.connect(artifact_root / "recovered/data/faunavault.db") as connection:
        assert connection.execute(
            "SELECT captured_at, extracted_captured_at, latitude, capture_metadata_overridden, location_metadata_overridden FROM photo WHERE id=?",
            (photo["id"],),
        ).fetchone() == (None, "2024-05-24 18:42:00.000000", 46.123456789, 1, 1)
        assert connection.execute(
            "SELECT capture_metadata_overridden, location_metadata_overridden FROM photo WHERE id=?",
            (other["id"],),
        ).fetchone() == (1, 1)
    export = create_metadata_export(
        artifact_root / "export", settings, include_csv=True
    )
    payload = json.loads(export.json_path.read_text())
    assert payload["format_version"] == 9
    exported = payload["photos"][0]
    assert exported["captured_at"] is None and exported["capture_metadata_overridden"]
    assert exported["extracted_captured_at"] == "2024-05-24T18:42:00.000000"
    assert exported["latitude"] == 46.123456789
    import csv

    with export.csv_path.open(newline="", encoding="utf-8") as source:
        rows = list(csv.DictReader(source))
    assert rows[0]["capture_metadata_overridden"] == "true"
    assert rows[0]["captured_at"] == r"\N"


def test_migration15_copies_prior_metadata_once(lifecycle):
    _, engine, settings = lifecycle
    with engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM schema_migration WHERE version=15")
        connection.exec_driver_sql(
            "INSERT INTO photo (original_filename, stored_filename, resized_filename, thumbnail_filename, status, captured_at, captured_at_offset_minutes, latitude, longitude, created_at, updated_at) VALUES ('old.jpg', 'old.jpg', 'old.jpg', 'old.jpg', 'pending', '2024-05-24T18:42:00', 120, 46, 14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
        )
        for name in (
            "extracted_captured_at",
            "extracted_captured_at_offset_minutes",
            "extracted_latitude",
            "extracted_longitude",
            "capture_metadata_overridden",
            "location_metadata_overridden",
        ):
            connection.exec_driver_sql(f"ALTER TABLE photo DROP COLUMN {name}")
    assert run_migrations(engine, settings) == [15]
    with engine.connect() as connection:
        assert connection.exec_driver_sql(
            "SELECT extracted_captured_at, extracted_captured_at_offset_minutes, extracted_latitude, extracted_longitude, capture_metadata_overridden, location_metadata_overridden FROM photo"
        ).one() == ("2024-05-24T18:42:00", 120, 46, 14, 0, 0)
    assert run_migrations(engine, settings) == []
    assert inspect_database(settings.database_path, 18).migrations[-1] == 18


@pytest.mark.parametrize(
    "changes",
    [
        "extracted_latitude=1",
        "extracted_captured_at='2024-05-24', extracted_captured_at_offset_minutes=120",
        "extracted_captured_at='2024-05-24T18:42:00', extracted_captured_at_offset_minutes=120.5",
        "capture_metadata_overridden=2",
        "location_metadata_overridden='invalid'",
    ],
)
def test_schema15_rejects_invalid_source_metadata(lifecycle, changes):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        connection.exec_driver_sql(
            f"UPDATE photo SET {changes} WHERE id=?", (photo["id"],)
        )
    with pytest.raises(ArchiveIntegrityError):
        inspect_database(settings.database_path, 16)


def test_filtered_map_uses_effective_capture_and_gps_and_restore(lifecycle):
    client, _, _ = lifecycle
    photo = upload(client, gps_metadata_jpeg_bytes()).json()
    original_filters = {"taken_from": "2024-05-24", "taken_to": "2024-05-24"}
    edited_filters = {"taken_from": "2026-01-01", "taken_to": "2026-01-01"}

    def points(filters):
        return client.get("/catalog/map", params=filters).json()

    assert points(original_filters)[0]["latitude"] == 46
    photo = patch(client, photo, latitude=None, longitude=None).json()
    assert points(original_filters) == []
    photo = patch(client, photo, latitude=0, longitude=0).json()
    assert points(original_filters)[0]["latitude"] == 0
    photo = patch(
        client,
        photo,
        latitude=12,
        longitude=13,
        captured_at="2026-01-01T23:59:59",
        captured_at_offset_minutes=-600,
    ).json()
    assert points(original_filters) == []
    assert points(edited_filters)[0]["longitude"] == 13
    photo = patch(
        client, photo, captured_at=None, captured_at_offset_minutes=None
    ).json()
    assert points(edited_filters) == []
    photo = patch(client, photo, restore_original_metadata=True).json()
    assert points(edited_filters) == []
    assert points(original_filters)[0]["latitude"] == photo["latitude"] == 46
    assert points(original_filters)[0]["captured_at"] == photo["captured_at"]
