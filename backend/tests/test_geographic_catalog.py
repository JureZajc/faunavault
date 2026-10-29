from __future__ import annotations

# ruff: noqa: F811
from datetime import datetime

import pytest
from sqlalchemy import event, text
from sqlmodel import Session

from app.catalog_query import CatalogQuery
from app.models import Photo
from app.services.catalog import list_photo_map_points
from tests.test_catalog import add_photo, add_taxon, catalog_app  # noqa: F401

BOX = dict(bbox_south=0, bbox_north=10, bbox_west=0, bbox_east=20)


def map_ids(client, **params):
    response = client.get("/catalog/map", params=BOX | params)
    assert response.status_code == 200, response.text
    return [point["id"] for point in response.json()]


def list_ids(client, **params):
    response = client.get("/catalog/photos", params=BOX | params)
    assert response.status_code == 200, response.text
    return [photo["id"] for photo in response.json()["items"]]


def test_empty_area(catalog_app):
    client, _ = catalog_app
    assert map_ids(client) == list_ids(client) == []
    assert client.get("/catalog/photos", params=BOX).json()["total"] == 0


@pytest.mark.parametrize("endpoint", ["photos", "map", "culling"])
@pytest.mark.parametrize(
    "invalid",
    [
        {"bbox_south": ""},
        {"bbox_south": "nan"},
        {"bbox_north": "inf"},
        {"bbox_west": "-inf"},
        {"bbox_east": "Infinity"},
        {"bbox_south": -91},
        {"bbox_north": 91},
        {"bbox_west": -181},
        {"bbox_east": 181},
        {"bbox_south": 10},
        {"bbox_south": 11},
        {"bbox_east": 0},
        {"bbox_west": 180, "bbox_east": -180},
    ],
)
def test_invalid_bounds(catalog_app, endpoint, invalid):
    client, _ = catalog_app
    assert client.get(f"/catalog/{endpoint}", params=BOX | invalid).status_code == 422


@pytest.mark.parametrize("missing", list(BOX))
@pytest.mark.parametrize("endpoint", ["photos", "map", "culling"])
def test_partial_bounds(catalog_app, missing, endpoint):
    client, _ = catalog_app
    assert (
        client.get(
            f"/catalog/{endpoint}",
            params={key: value for key, value in BOX.items() if key != missing},
        ).status_code
        == 422
    )


def test_inclusive_boundaries_zero_gps_pagination_and_lifecycle(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        ids = [
            add_photo(session, i, latitude=lat, longitude=lng).id
            for i, (lat, lng) in enumerate(
                [
                    (0, 0),
                    (10, 20),
                    (5, 10),
                    (-0.00001, 10),
                    (5, 20.00001),
                    (None, None),
                ]
            )
        ]
        session.commit()
    assert map_ids(client) == ids[:3]
    assert list_ids(client, sort="name", order="asc") == ids[:3]
    response = client.get(
        "/catalog/photos",
        params=BOX | dict(page=2, page_size=2, sort="name", order="asc"),
    ).json()
    assert response["total"] == 3 and response["total_pages"] == 2
    assert [photo["id"] for photo in response["items"]] == [ids[2]]
    assert client.delete(f"/photos/{ids[0]}").status_code == 200
    assert map_ids(client) == ids[1:3]
    assert set(list_ids(client)) == set(ids[1:3])
    assert client.post(f"/trash/photos/{ids[0]}/restore").status_code == 200
    current = client.get(f"/photos/{ids[2]}").json()
    corrected = client.patch(
        f"/photos/{ids[2]}",
        params={"expected_updated_at": current["updated_at"]},
        json={"latitude": -5, "longitude": -10},
    )
    assert corrected.status_code == 200, corrected.text
    assert map_ids(client) == ids[:2]
    assert set(list_ids(client)) == set(ids[:2])


def test_antimeridian(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        ids = [
            add_photo(session, i, latitude=5, longitude=lng).id
            for i, lng in enumerate(
                [170, 179.999, -170, -179.999, 180, -180, 0, 169.999, -169.999]
            )
        ]
        session.commit()
    crossing = dict(bbox_west=170, bbox_east=-170)
    assert map_ids(client, **crossing) == ids[:6]
    assert set(list_ids(client, **crossing)) == set(ids[:6])
    assert map_ids(client, bbox_west=-180, bbox_east=180) == ids


def test_legacy_incomplete_or_invalid_gps_is_excluded(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        ids = [add_photo(session, i, latitude=5, longitude=10).id for i in range(5)]
        session.commit()
    # Simulate old/corrupt rows without going through modern metadata validation.
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        for photo_id, latitude, longitude in [
            (ids[1], None, 10),
            (ids[2], 5, None),
            (ids[3], 95, 10),
            (ids[4], 5, float("inf")),
        ]:
            connection.execute(
                text("UPDATE photo SET latitude=:lat, longitude=:lng WHERE id=:id"),
                dict(id=photo_id, lat=latitude, lng=longitude),
            )
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")
    assert map_ids(client) == list_ids(client) == [ids[0]]
    assert [point["id"] for point in client.get("/catalog/map").json()] == [ids[0]]


def test_intersections_and_lightweight_map_query(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Testus geographicus")
        taxon_id = taxon.id
        ids = [
            add_photo(
                session,
                i,
                latitude=5 if i < 3 else 15,
                longitude=10,
                category="bird",
                taxon=taxon,
                tags=["area", "bird"],
                camera_make="Canon",
                camera_model="R5",
                lens_model="RF 100",
                captured_at=datetime(2026, 1, 3),
                rating=4,
                is_favorite=True,
                culling_state="pick",
            ).id
            for i in range(4)
        ]
        session.commit()
    common = dict(
        category="bird",
        taxon_id=taxon_id,
        taken_from="2026-01-01",
        taken_to="2026-01-31",
        status="pending",
    )
    assert map_ids(client, **common) == ids[:3]
    assert set(list_ids(client, **common)) == set(ids[:3])
    # Broad search/Taxon count shortcuts must not drop the geographic predicate.
    for extra in [
        dict(taxon_id=taxon_id),
        dict(search="photo"),
        dict(taxon_id=taxon_id, search="photo"),
    ]:
        response = client.get("/catalog/photos", params=BOX | extra).json()
        assert response["total"] == 3
        assert len(response["items"]) == 3
        assert response["total_pages"] == 1
    for extra in [
        dict(tags=["area", "bird"]),
        dict(camera_make="Canon", camera_model="R5", lens_model="RF 100"),
        dict(rating_min=4, favorites_only=True, culling_state="pick"),
    ]:
        assert set(list_ids(client, **common, **extra)) == set(ids[:3])
    assert list_ids(client, tags=["absent"]) == []
    assert list_ids(client, camera_model="R6") == []
    assert list_ids(client, taken_from="2027-01-01") == []
    trip = client.post(
        "/events",
        json=dict(
            kind="trip",
            title="Area trip",
            start_date="2026-01-01",
            end_date="2026-01-31",
        ),
    )
    assert trip.status_code == 201, trip.text
    event_id = trip.json()["id"]
    membership = client.post(
        f"/events/{event_id}/photos", json={"photo_ids": [ids[0], ids[3]]}
    )
    assert membership.status_code == 200, membership.text
    assert (
        map_ids(client, event_id=event_id)
        == list_ids(client, event_id=event_id)
        == [ids[0]]
    )
    statements = []
    hydrated = []

    def record_sql(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    def record_photo(photo, _context):
        hydrated.append(photo.id)

    event.listen(engine, "before_cursor_execute", record_sql)
    event.listen(Photo, "load", record_photo)
    try:
        with Session(engine) as session:
            assert (
                len(list_photo_map_points(session, CatalogQuery(**BOX, **common))) == 3
            )
    finally:
        event.remove(engine, "before_cursor_execute", record_sql)
        event.remove(Photo, "load", record_photo)
    assert len(statements) == 1
    assert "BETWEEN" in statements[0] and "ORDER BY photo.id ASC" in statements[0]
    assert not hydrated
