from __future__ import annotations

import sqlite3
from datetime import datetime

import pytest
from sqlmodel import Session

import app.services.bulk_capture_metadata as bulk
from app.models import Photo, utc_now
from app.services.photo_metadata_backfill import backfill_photo_metadata
from tests.test_bulk_photos import bulk_app as bulk_app
from tests.test_bulk_photos import seed_photos
from tests.test_capture_metadata_editing import gps_metadata_jpeg_bytes
from tests.test_photo_lifecycle import jpeg_bytes, upload
from tests.test_photo_lifecycle import lifecycle as lifecycle

PREVIEW = "/photos/bulk/capture-preview"
APPLY = "/photos/bulk/capture-apply"


def preview(client, ids, **change):
    response = client.post(PREVIEW, json={"photo_ids": ids, "change": change})
    assert response.status_code == 200, response.text
    return response.json()


def apply(client, result):
    return client.post(
        APPLY,
        json={
            "photo_ids": [row["photo_id"] for row in result["photos"]],
            "change": result["change"],
            "expected_versions": [
                {key: row[key] for key in ("photo_id", "updated_at", "original_sha256")}
                for row in result["photos"]
            ],
        },
    )


def snapshot(engine, ids):
    with Session(engine) as session:
        return [
            session.get(Photo, photo_id).model_dump(mode="json") for photo_id in ids
        ]


@pytest.mark.parametrize(
    "start,minutes,end",
    [
        ("2025-12-31T23:30:00", 120, "2026-01-01T01:30:00"),
        ("2026-01-01T00:30:00", -60, "2025-12-31T23:30:00"),
        ("2024-02-28T23:45:00", 30, "2024-02-29T00:15:00"),
        ("2024-03-01T00:00:00", -1, "2024-02-29T23:59:00"),
        ("2025-02-28T23:45:00", 30, "2025-03-01T00:15:00"),
        ("2026-10-01T00:00:00.123456", -1, "2026-09-30T23:59:00.123456"),
    ],
)
def test_shift_boundaries_preserves_offsets_and_unrelated_data(
    bulk_app, start, minutes, end
):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {}, {})
    with Session(engine) as session:
        for index, photo_id in enumerate(ids):
            photo = session.get(Photo, photo_id)
            photo.captured_at = datetime.fromisoformat(start)
            photo.captured_at_offset_minutes = [None, -330, 120][index]
            photo.extracted_captured_at = datetime(2020, 1, 1)
            photo.extracted_captured_at_offset_minutes = 0
            photo.status = "needs_review"
            photo.tags = ["wildlife"]
            photo.rating = 4
            photo.is_favorite = True
            photo.culling_state = "reject"
            photo.reviewed_at = datetime(2025, 1, 1)
            session.add(photo)
        session.commit()
    before = snapshot(engine, ids)
    result = preview(client, ids, operation="shift_time", minutes=minutes)
    assert snapshot(engine, ids) == before  # Includes versions and provenance.
    assert result["affected_count"] == 3 and result["can_apply"]
    assert [row["after"]["captured_at_offset_minutes"] for row in result["photos"]] == [
        None,
        -330,
        120,
    ]
    assert apply(client, result).json()["affected_count"] == 3
    after = snapshot(engine, ids)
    for old, new in zip(before, after, strict=True):
        assert new["captured_at"] == end
        assert new["capture_metadata_overridden"]
        for key in old.keys() - {
            "captured_at",
            "capture_metadata_overridden",
            "updated_at",
        }:
            assert new[key] == old[key], key


def test_shift_preserves_relative_differences(bulk_app):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {})
    with Session(engine) as session:
        for photo_id, hour in zip(ids, (12, 15), strict=True):
            photo = session.get(Photo, photo_id)
            photo.captured_at = datetime(2024, 1, 1, hour, 30)
            session.add(photo)
        session.commit()
    result = preview(client, ids, operation="shift_time", minutes=120)
    assert [row["after"]["captured_at"] for row in result["photos"]] == [
        "2024-01-01T14:30:00",
        "2024-01-01T17:30:00",
    ]


@pytest.mark.parametrize(
    "value,minutes,code",
    [
        (None, 60, "missing_capture_time"),
        (datetime(9999, 12, 31, 23, 59), 1, "capture_time_overflow"),
        (datetime(1, 1, 1), -1, "capture_time_overflow"),
        (datetime(2024, 1, 1), 10**100, "capture_time_overflow"),
    ],
)
def test_blocked_shift_is_read_only_and_apply_is_atomic(bulk_app, value, minutes, code):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {})
    with Session(engine) as session:
        for photo_id, captured in zip(ids, (datetime(2024, 1, 1), value), strict=True):
            photo = session.get(Photo, photo_id)
            photo.captured_at = captured
            session.add(photo)
        session.commit()
    before = snapshot(engine, ids)
    result = preview(client, ids, operation="shift_time", minutes=minutes)
    assert not result["can_apply"]
    assert result["photos"][1]["issue"]["code"] == code
    response = apply(client, result)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "capture_operation_blocked"
    assert snapshot(engine, ids) == before


@pytest.mark.parametrize(
    "mode,offset",
    [
        ("preserve", None),
        ("assign", None),
        ("assign", 0),
        ("assign", -1439),
        ("assign", 1439),
    ],
)
def test_set_capture_offset_modes(bulk_app, mode, offset):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {})
    with Session(engine) as session:
        photo = session.get(Photo, ids[0])
        photo.captured_at = datetime(2024, 1, 1)
        photo.captured_at_offset_minutes = -330
        session.add(photo)
        session.commit()
    change = {
        "operation": "set_capture",
        "captured_at": "2024-02-29T12:30:00",
        "offset_mode": mode,
    }
    if mode == "assign":
        change["captured_at_offset_minutes"] = offset
    result = preview(client, ids, **change)
    assert apply(client, result).status_code == 200
    assert [row["captured_at_offset_minutes"] for row in snapshot(engine, ids)] == (
        [-330, None] if mode == "preserve" else [offset, offset]
    )


@pytest.mark.parametrize(
    "change",
    [
        {
            "operation": "set_capture",
            "captured_at": "2025-02-29T12:00:00",
            "offset_mode": "preserve",
        },
        {
            "operation": "set_capture",
            "captured_at": "2024-02-29T12:00:00Z",
            "offset_mode": "preserve",
        },
        {
            "operation": "set_capture",
            "captured_at": "2024-02-29",
            "offset_mode": "preserve",
        },
        {
            "operation": "set_capture",
            "captured_at": "2024-02-29T12:00:00",
            "offset_mode": "assign",
        },
        {
            "operation": "set_capture",
            "captured_at": "2024-02-29T12:00:00",
            "offset_mode": "preserve",
            "captured_at_offset_minutes": 0,
        },
        *[
            {
                "operation": "set_capture",
                "captured_at": "2024-02-29T12:00:00",
                "offset_mode": "assign",
                "captured_at_offset_minutes": offset,
            }
            for offset in (1440, -1440, True, 1.5)
        ],
        {"operation": "set_gps", "latitude": 91, "longitude": 0},
        {"operation": "set_gps", "latitude": 0, "longitude": -181},
        {"operation": "set_gps", "latitude": 0},
        {"operation": "set_gps", "latitude": "NaN", "longitude": 0},
        {"operation": "set_gps", "latitude": True, "longitude": 0},
        {"operation": "set_gps", "latitude": None, "longitude": None},
        {"operation": "shift_time", "minutes": 1.5},
        {"operation": "restore_original", "group": "other"},
    ],
)
def test_invalid_operations_rejected_by_both_endpoints(bulk_app, change):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {})
    before = snapshot(engine, ids)
    assert (
        client.post(PREVIEW, json={"photo_ids": ids, "change": change}).status_code
        == 422
    )
    assert (
        client.post(
            APPLY, json={"photo_ids": ids, "change": change, "expected_versions": []}
        ).status_code
        == 422
    )
    assert snapshot(engine, ids) == before


@pytest.mark.parametrize(
    "latitude,longitude", [(-90, -180), (90, 180), (0, 0), (46.123456789, 14.987654321)]
)
def test_set_gps_and_noop_versions(bulk_app, latitude, longitude):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {})
    result = preview(
        client, ids, operation="set_gps", latitude=latitude, longitude=longitude
    )
    assert apply(client, result).status_code == 200
    before = snapshot(engine, ids)
    assert all(
        photo["location_metadata_overridden"]
        and photo["latitude"] == latitude
        and photo["longitude"] == longitude
        for photo in before
    )
    result = preview(
        client, ids, operation="set_gps", latitude=latitude, longitude=longitude
    )
    assert result["affected_count"] == 0
    assert apply(client, result).json()["affected_count"] == 0
    assert snapshot(engine, ids) == before


@pytest.mark.parametrize(
    "ids,status,code",
    [
        ([], 422, "empty_photo_ids"),
        ([1, 1], 422, "duplicate_photo_ids"),
        ([1, 999], 404, "photos_not_found"),
        ([1, 2], 409, "photos_not_active"),
        (list(range(1, 252)), 413, "too_many_photo_ids"),
        ([0], 422, "invalid_photo_ids"),
    ],
)
def test_id_validation(bulk_app, ids, status, code):
    client, engine, _ = bulk_app
    seed_photos(engine, {}, {"deleted": True})
    before = snapshot(engine, [1, 2])
    for endpoint in (PREVIEW, APPLY):
        body = {"photo_ids": ids, "change": {"operation": "remove_gps"}}
        if endpoint == APPLY:
            body["expected_versions"] = [
                {"photo_id": photo_id, "updated_at": "unused"} for photo_id in ids
            ]
        response = client.post(endpoint, json=body)
        assert response.status_code == status
        assert response.json()["detail"]["code"] == code
    assert snapshot(engine, [1, 2]) == before


def test_exact_version_coverage_and_stale_conflicts(bulk_app):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {})
    result = preview(client, ids, operation="remove_gps")
    versions = [
        {"photo_id": row["photo_id"], "updated_at": row["updated_at"]}
        for row in result["photos"]
    ]
    for invalid in (
        [],
        versions[:1],
        [versions[0], versions[0]],
        [*versions, {"photo_id": 999, "updated_at": "old"}],
    ):
        response = client.post(
            APPLY,
            json={
                "photo_ids": ids,
                "change": result["change"],
                "expected_versions": invalid,
            },
        )
        assert response.status_code == 422
    with Session(engine) as session:
        photo = session.get(Photo, ids[1])
        photo.status = "classified"  # Simulate a worker finishing after preview.
        photo.updated_at = utc_now()
        session.add(photo)
        session.commit()
    before = snapshot(engine, ids)
    response = apply(client, result)
    assert response.status_code == 409
    assert response.json()["detail"]["photo_ids"] == [ids[1]]
    assert snapshot(engine, ids) == before


def test_database_failure_rolls_back_all_rows(bulk_app):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {}, {})
    before = snapshot(engine, ids)
    result = preview(client, ids, operation="set_gps", latitude=12, longitude=34)

    with engine.begin() as connection:
        connection.exec_driver_sql(
            f"CREATE TRIGGER fail_second BEFORE UPDATE ON photo WHEN NEW.id = {ids[1]} BEGIN SELECT RAISE(ABORT, 'simulated second-row write failure'); END"
        )
    try:
        assert apply(client, result).status_code == 500
    finally:
        with engine.begin() as connection:
            connection.exec_driver_sql("DROP TRIGGER fail_second")
    assert snapshot(engine, ids) == before


def test_writer_lock_covers_validation_and_mutation(bulk_app, monkeypatch):
    client, engine, settings = bulk_app
    ids = seed_photos(engine, {})
    result = preview(client, ids, operation="remove_gps")
    original_plan = bulk._plan
    attempts = []

    def competing_plan(*args):
        with sqlite3.connect(settings.database_path, timeout=0.001) as connection:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                connection.execute(
                    "UPDATE photo SET status = 'classified' WHERE id = ?", (ids[0],)
                )
            attempts.append(True)
        return original_plan(*args)

    monkeypatch.setattr(bulk, "_plan", competing_plan)
    assert apply(client, result).status_code == 200
    assert attempts == [True]


@pytest.mark.parametrize("group", ["capture", "location", "both"])
def test_clear_and_independent_verified_restore_preserve_originals(lifecycle, group):
    client, engine, settings = lifecycle
    photo = upload(client, gps_metadata_jpeg_bytes()).json()
    ids = [photo["id"]]
    path = settings.image_dirs["original"] / photo["stored_filename"]
    original_bytes = path.read_bytes()
    for operation in ("clear_capture", "remove_gps"):
        result = preview(client, ids, operation=operation)
        assert apply(client, result).status_code == 200
    cleared = snapshot(engine, ids)[0]
    assert (
        cleared["captured_at"] is None and cleared["captured_at_offset_minutes"] is None
    )
    assert cleared["latitude"] is None and cleared["longitude"] is None
    assert (
        cleared["capture_metadata_overridden"]
        and cleared["location_metadata_overridden"]
    )
    assert cleared["extracted_captured_at"] == photo["extracted_captured_at"]
    assert cleared["extracted_latitude"] == 46
    assert backfill_photo_metadata(settings, apply=True).updated == 0
    assert snapshot(engine, ids)[0] == cleared
    # Retained values are deliberately stale: restore must re-extract the original.
    with Session(engine) as session:
        stored = session.get(Photo, ids[0])
        stored.extracted_captured_at = datetime(2000, 1, 1)
        stored.extracted_latitude = 1
        session.add(stored)
        session.commit()
    before = snapshot(engine, ids)
    result = preview(client, ids, operation="restore_original", group=group)
    assert snapshot(engine, ids) == before
    assert result["photos"][0]["original_sha256"] == photo["content_sha256"]
    assert apply(client, result).status_code == 200
    restored = snapshot(engine, ids)[0]
    assert restored["captured_at"] == (
        photo["captured_at"] if group != "location" else None
    )
    assert restored["capture_metadata_overridden"] == (group == "location")
    assert restored["latitude"] == (46 if group != "capture" else None)
    assert restored["location_metadata_overridden"] == (group == "capture")
    assert restored["extracted_captured_at"] == (
        photo["captured_at"] if group != "location" else "2000-01-01T00:00:00"
    )
    assert restored["extracted_latitude"] == (46 if group != "capture" else 1)
    assert path.read_bytes() == original_bytes


@pytest.mark.parametrize("failure", ["missing", "corrupt", "checksum", "link"])
def test_original_failures_block_entire_restore(lifecycle, failure):
    client, engine, settings = lifecycle
    photos = [
        upload(client, gps_metadata_jpeg_bytes()).json(),
        client.post(
            "/photos/upload",
            data={"allow_visual_duplicate": "true"},
            files={"file": ("second.jpg", jpeg_bytes(), "image/jpeg")},
        ).json(),
    ]
    ids = [photo["id"] for photo in photos]
    assert (
        apply(client, preview(client, ids, operation="clear_capture")).status_code
        == 200
    )
    good_preview = preview(client, ids, operation="restore_original", group="both")
    path = settings.image_dirs["original"] / photos[1]["stored_filename"]
    if failure == "missing":
        path.unlink()
    elif failure == "link":
        path.unlink()
        try:
            path.symlink_to(
                settings.image_dirs["original"] / photos[0]["stored_filename"]
            )
        except OSError:
            pytest.skip("Creating symlinks is not permitted on this host")
    else:
        path.write_bytes(
            b"corrupt" if failure == "corrupt" else path.read_bytes() + b"modified"
        )
        if failure == "corrupt":
            with Session(engine) as session:
                photo = session.get(Photo, ids[1])
                photo.content_sha256 = None
                photo.original_size_bytes = None
                session.add(photo)
                session.commit()
    before = snapshot(engine, ids)
    result = preview(client, ids, operation="restore_original", group="both")
    assert result["blocked_count"] == 1 and not result["can_apply"]
    assert result["photos"][1]["issue"]["code"] == "original_metadata_unavailable"
    assert apply(client, good_preview).status_code == 422
    assert snapshot(engine, ids) == before


def test_legacy_original_changed_after_preview_is_rejected(lifecycle):
    client, engine, settings = lifecycle
    photo = upload(client, gps_metadata_jpeg_bytes()).json()
    ids = [photo["id"]]
    with Session(engine) as session:
        stored = session.get(Photo, ids[0])
        stored.content_sha256 = None
        stored.original_size_bytes = None
        session.add(stored)
        session.commit()
    result = preview(client, ids, operation="restore_original", group="both")
    path = settings.image_dirs["original"] / photo["stored_filename"]
    path.write_bytes(path.read_bytes() + b"changed-after-preview")
    before = snapshot(engine, ids)
    response = apply(client, result)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "originals_changed"
    assert snapshot(engine, ids) == before


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity", "1e999"])
def test_nonfinite_json_coordinates_are_safely_rejected(bulk_app, number):
    client, engine, _ = bulk_app
    ids = seed_photos(engine, {})
    response = client.post(
        PREVIEW,
        content=f'{{"photo_ids":{ids},"change":{{"operation":"set_gps","latitude":{number},"longitude":0}}}}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_250_photos_can_be_previewed_and_applied(bulk_app):
    client, engine, _ = bulk_app
    with Session(engine) as session:
        photos = [
            Photo(
                original_filename=f"{index}.jpg",
                stored_filename=f"{index}.jpg",
                resized_filename=f"{index}-resized.jpg",
                thumbnail_filename=f"{index}-thumb.jpg",
            )
            for index in range(250)
        ]
        session.add_all(photos)
        session.commit()
        ids = [photo.id for photo in photos]
    result = preview(client, ids, operation="remove_gps")
    assert result["selected_count"] == result["affected_count"] == 250
    assert apply(client, result).json()["affected_count"] == 250


def test_bulk_changes_drive_existing_views_and_preserve_memberships(lifecycle):
    client, engine, _ = lifecycle
    photo = upload(client, gps_metadata_jpeg_bytes()).json()
    ids = [photo["id"]]
    collection = client.post("/collections", json={"name": "Bulk test"}).json()
    trip = client.post(
        "/events",
        json={
            "kind": "trip",
            "title": "Bulk trip",
            "start_date": "2026-08-12",
            "end_date": "2026-08-17",
        },
    ).json()
    assert (
        client.post(
            f"/collections/{collection['id']}/photos", json={"photo_ids": ids}
        ).status_code
        == 200
    )
    assert (
        client.post(f"/events/{trip['id']}/photos", json={"photo_ids": ids}).status_code
        == 200
    )
    filters = {"taken_from": "2026-08-12", "taken_to": "2026-08-17"}
    smart = client.post(
        "/smart-collections",
        json={"name": "Bulk dates", "query_version": 1, "query": filters},
    ).json()

    def members():
        with engine.connect() as connection:
            return {
                table: connection.exec_driver_sql(f"SELECT * FROM {table}").all()
                for table in (
                    "collection",
                    "collection_photo",
                    "archive_event",
                    "archive_event_photo",
                    "import_session",
                    "animal",
                    "classification_job",
                )
            }

    before_members = members()
    original_animal_id, original_import_id = (
        photo["animal_id"],
        photo["import_session_id"],
    )
    assert client.get(f"/smart-collections/{smart['id']}/photos").json()["total"] == 0
    result = preview(
        client,
        ids,
        operation="set_capture",
        captured_at="2026-08-15T23:59:59",
        offset_mode="preserve",
    )
    assert apply(client, result).status_code == 200
    assert (
        apply(
            client, preview(client, ids, operation="set_gps", latitude=12, longitude=34)
        ).status_code
        == 200
    )
    detail = client.get(f"/photos/{ids[0]}").json()
    assert detail["captured_at"] == "2026-08-15T23:59:59" and detail["latitude"] == 12
    assert (
        detail["animal_id"] == original_animal_id
        and detail["import_session_id"] == original_import_id
    )
    # List filtering/sorting and Trips & Events suggestions share this query.
    catalog = client.get(
        "/catalog/photos", params={**filters, "sort": "captured_at"}
    ).json()
    assert [row["id"] for row in catalog["items"]] == ids
    assert (
        client.get("/catalog/photos", params={"taken_to": "2024-12-31"}).json()["total"]
        == 0
    )
    assert client.get("/catalog/timeline").json()["years"][0]["year"] == 2026
    point = client.get("/catalog/map", params=filters).json()[0]
    assert (
        point["id"] == ids[0] and point["latitude"] == 12 and point["longitude"] == 34
    )
    assert client.get(f"/smart-collections/{smart['id']}/photos").json()["total"] == 1
    insights = client.get("/insights", params={"year": 2026}).json()
    assert insights["overview"]["total_photos"] == 1
    assert insights["overview"]["gps"]["known"] == 1
    assert members() == before_members
