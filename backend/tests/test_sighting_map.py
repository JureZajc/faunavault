# ruff: noqa: F811
from datetime import datetime

import pytest
from sqlalchemy import insert
from sqlmodel import Session

from app.models import Photo, Sighting
from app.services.sighting_map import MAP_POINT_LIMIT
from tests.test_catalog import add_taxon
from tests.test_collections import collections_app, seed_photos  # noqa: F401
from tests.test_photo_lifecycle import jpeg_bytes, lifecycle  # noqa: F401
from tests.test_sightings import OBSERVED, create


def get_map(client, **filters):
    response = client.get("/sightings/map", params=filters)
    assert response.status_code == 200, response.text
    return response.json()


def ids(result):
    return [point["id"] for point in result["points"]]


def test_empty_archive(collections_app):
    client, _, _ = collections_app
    assert get_map(client) == {
        "points": [],
        "total_matching": 0,
        "without_location_count": 0,
        "truncated": False,
    }


def test_one_point_per_encounter_including_zero_and_unlinked(collections_app):
    client, engine, _ = collections_app
    first, second = seed_photos(engine, count=2)
    with Session(engine) as session:
        photo = session.get(Photo, first)
        photo.captured_at = datetime(1990, 1, 1)
        photo.latitude, photo.longitude = 45, 12
        taxon = add_taxon(session, "Vulpes vulpes", "Red fox")
        taxon_id = taxon.id
        session.commit()

    item = create(
        client,
        [first, second],
        latitude=0,
        longitude=0,
        taxon_id=taxon_id,
        subject_label="Fox crossing",
        location_label="Meadow",
    )
    assert get_map(client)["points"] == [
        {
            "id": item["id"],
            "latitude": 0,
            "longitude": 0,
            "observed_at": OBSERVED,
            "subject_label": "Fox crossing",
            "location_label": "Meadow",
            "taxon_id": taxon_id,
            "common_name": "Red fox",
            "scientific_name": "Vulpes vulpes",
            "thumbnail_filename": "photo-1-thumb.jpg",
        }
    ]

    duplicate_position = create(client, [first], latitude=0, longitude=0)
    assert create(client, [first])["latitude"] is None
    unlinked = create(client, [second], latitude=-46, longitude=-120)
    response = client.request(
        "DELETE", f"/sightings/{unlinked['id']}/photos", json={"photo_ids": [second]}
    )
    assert response.status_code == 200
    result = get_map(client)
    assert ids(result) == [unlinked["id"], duplicate_position["id"], item["id"]]
    assert result["total_matching"] == 4 and result["without_location_count"] == 1
    assert result["points"][0]["thumbnail_filename"] is None
    assert (
        result["points"][1]["taxon_id"]
        is result["points"][1]["scientific_name"]
        is None
    )


def test_and_filters_field_local_dates_taxon_and_antimeridian(collections_app):
    client, engine, _ = collections_app
    photo_ids = seed_photos(engine, count=1)
    with Session(engine) as session:
        fox_id = add_taxon(session, "Vulpes vulpes").id
        hare_id = add_taxon(session, "Lepus europaeus").id
        session.commit()

    def record(latitude, longitude, **fields):
        return create(
            client, photo_ids, latitude=latitude, longitude=longitude, **fields
        )["id"]

    start = record(
        -10,
        170,
        taxon_id=fox_id,
        observed_at="2026-08-22T00:00:00",
        observed_at_offset_minutes=120,
    )
    end = record(
        10,
        -170,
        taxon_id=fox_id,
        observed_at="2026-08-23T23:59:59.999999",
        observed_at_offset_minutes=-120,
    )
    record(0, -179, taxon_id=fox_id, observed_at="2026-08-24T00:00:00")
    record(0, 179, taxon_id=hare_id)
    record(0, 0, taxon_id=fox_id)
    record(11, 180, taxon_id=fox_id)
    record(None, None, taxon_id=fox_id)
    record(None, None, taxon_id=hare_id)
    result = get_map(
        client,
        date_from="2026-08-22",
        date_to="2026-08-23",
        taxon_id=fox_id,
        bbox_south=-10,
        bbox_north=10,
        bbox_west=170,
        bbox_east=-170,
    )
    assert ids(result) == [end, start]
    assert result["total_matching"] == 3 and result["without_location_count"] == 1
    result = get_map(client, bbox_south=0, bbox_north=1, bbox_west=0, bbox_east=1)
    assert len(result["points"]) == 1
    assert result["points"][0]["latitude"] == result["points"][0]["longitude"] == 0


def test_legacy_invalid_and_partial_coordinates_count_as_unlocated(collections_app):
    client, engine, _ = collections_app
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        try:
            connection.execute(
                insert(Sighting),
                [
                    {
                        "observed_at": datetime(2026, 1, 1),
                        "latitude": latitude,
                        "longitude": longitude,
                    }
                    for latitude, longitude in [
                        (None, 12),
                        (91, 12),
                        (0, float("inf")),
                        (0, 0),
                    ]
                ],
            )
        finally:
            connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")
    result = get_map(client)
    assert ids(result) == [4]
    assert result["total_matching"] == 4 and result["without_location_count"] == 3


def test_thumbnail_fallback_trash_restore_purge_edit_and_delete(lifecycle):
    client, engine, _ = lifecycle
    photos = []
    for color in ("red", "green", "blue"):
        response = client.post(
            "/photos/upload",
            files={"file": (f"{color}.jpg", jpeg_bytes(color=color), "image/jpeg")},
            data={"allow_visual_duplicate": "true"},
        )
        assert response.status_code == 200, response.text
        photos.append(response.json())
    first, second, third = (photo["id"] for photo in photos)
    with Session(engine) as session:
        session.get(Photo, first).thumbnail_filename = ""
        session.commit()
    item = create(client, [first, second, third], latitude=45, longitude=15)
    url = f"/sightings/{item['id']}"

    def point():
        result = get_map(client)
        assert ids(result) == [item["id"]]
        return result["points"][0]

    assert point()["thumbnail_filename"] == photos[1]["thumbnail_filename"]
    assert client.delete(f"/photos/{second}").status_code == 200
    assert point()["thumbnail_filename"] == photos[2]["thumbnail_filename"]
    assert client.delete(f"/photos/{third}").status_code == 200
    assert point()["thumbnail_filename"] is None
    assert client.post(f"/trash/photos/{second}/restore").status_code == 200
    assert point()["thumbnail_filename"] == photos[1]["thumbnail_filename"]
    assert client.delete(f"/trash/photos/{third}").status_code == 200
    assert point()["thumbnail_filename"] == photos[1]["thumbnail_filename"]
    assert (
        client.patch(url, json={"latitude": -90, "longitude": -180}).status_code == 200
    )
    assert (point()["latitude"], point()["longitude"]) == (-90, -180)
    assert client.delete(url).status_code == 200
    assert get_map(client)["points"] == []


def test_limit_exact_totals_deterministic_order_and_focus(collections_app):
    client, engine, _ = collections_app
    stamp = datetime.fromisoformat(OBSERVED)
    with engine.begin() as connection:
        connection.execute(
            insert(Sighting),
            [{"observed_at": stamp, "latitude": 1, "longitude": 1}]
            * (MAP_POINT_LIMIT + 3),
        )
        connection.execute(insert(Sighting), [{"observed_at": stamp}])
    result = get_map(client)
    assert result["truncated"] is True
    assert result["total_matching"] == MAP_POINT_LIMIT + 4
    assert result["without_location_count"] == 1
    expected = list(range(MAP_POINT_LIMIT + 3, 3, -1))
    assert ids(result) == expected
    assert ids(get_map(client, focus=1)) == [*expected[:-1], 1]
    assert ids(get_map(client, focus=MAP_POINT_LIMIT + 4)) == expected
    narrowed = get_map(
        client, focus=1, bbox_south=2, bbox_north=3, bbox_west=2, bbox_east=3
    )
    assert narrowed == {
        "points": [],
        "total_matching": 1,
        "without_location_count": 1,
        "truncated": False,
    }


@pytest.mark.parametrize(
    "filters",
    [
        {"date_from": "2026-08-24", "date_to": "2026-08-23"},
        {"date_from": "2026-02-30"},
        {"date_to": "2026-08-24T00:00:00"},
        {"date_from": "0"},
        {"taxon_id": 0},
        {"taxon_id": 2**63},
        {"focus": -1},
        {"bbox_south": 0},
        *[
            {
                "bbox_south": -10,
                "bbox_north": 10,
                "bbox_west": -20,
                "bbox_east": 20,
                **change,
            }
            for change in (
                {"bbox_south": "nan"},
                {"bbox_east": "inf"},
                {"bbox_west": "abc"},
                {"bbox_south": -91},
                {"bbox_east": 181},
                {"bbox_south": 10},
                {"bbox_west": 20},
                {"bbox_west": 180, "bbox_east": -180},
            )
        ],
    ],
)
def test_api_validation(collections_app, filters):
    client, _, _ = collections_app
    response = client.get("/sightings/map", params=filters)
    assert response.status_code == 422, response.text
