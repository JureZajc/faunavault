from __future__ import annotations

# ruff: noqa: F811
import math
import random
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy import event, text
from sqlmodel import Session

from app.models import Photo
from app.services import nearby_photos as service
from app.services.geography import great_circle_distance_m
from tests.test_catalog import add_photo, catalog_app  # noqa: F401


def seed(engine, locations, **metadata):
    with Session(engine) as session:
        ids = [
            add_photo(session, i, latitude=lat, longitude=lon, **metadata).id
            for i, (lat, lon) in enumerate(locations)
        ]
        session.commit()
    return ids


def nearby(client, photo_id, **params):
    response = client.get(f"/photos/{photo_id}/nearby", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def reference_distance(a, b):
    # Independent vector cross/dot atan2 calculation; intentionally no Haversine.
    def vector(pair):
        lat, lon = map(math.radians, pair)
        return (
            math.cos(lat) * math.cos(lon),
            math.cos(lat) * math.sin(lon),
            math.sin(lat),
        )

    u, v = vector(a), vector(b)
    cross = [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
    return 6_371_008.8 * math.atan2(
        math.sqrt(sum(x * x for x in cross)),
        sum(x * y for x, y in zip(u, v, strict=True)),
    )


def test_empty_missing_trashed_and_single_source(catalog_app):
    client, engine = catalog_app
    assert client.get("/photos/1/nearby").status_code == 404
    source = seed(engine, [(0, 0)])[0]
    assert nearby(client, source) == dict(
        source_photo_id=source,
        radius_km=5,
        availability="available",
        unavailable_reason=None,
        total=0,
        items=[],
    )
    assert client.get("/photos/99999/nearby").status_code == 404
    assert client.delete(f"/photos/{source}").status_code == 200
    assert client.get(f"/photos/{source}/nearby").status_code == 404


@pytest.mark.parametrize(
    "params",
    [{"radius_km": value} for value in [0, 2, 26, "5.0", "nan", "inf", ""]]
    + [{"limit": value} for value in [0, -1, 25, "1.5"]],
)
def test_query_validation(catalog_app, params):
    client, _ = catalog_app
    assert client.get("/photos/1/nearby", params=params).status_code == 422


@pytest.mark.parametrize(
    "coordinates",
    [
        (None, None),
        (0, None),
        (None, 0),
        (91, 0),
        (-91, 0),
        (0, 181),
        (0, -181),
        (float("inf"), 0),
        (0, float("nan")),
        ("broken", 0),
    ],
)
def test_missing_and_legacy_invalid_gps(catalog_app, coordinates):
    client, engine = catalog_app
    source, candidate = seed(
        engine,
        [(0, 0), (0, 0)],
        extracted_latitude=0,
        extracted_longitude=0,
        location_metadata_overridden=True,
    )
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        connection.execute(
            text("UPDATE photo SET latitude=:lat, longitude=:lon WHERE id=:id"),
            dict(lat=coordinates[0], lon=coordinates[1], id=candidate),
        )
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")
    assert nearby(client, source)["items"] == []
    unavailable = nearby(client, candidate)
    assert unavailable["availability"] == "unavailable"
    assert unavailable["unavailable_reason"] == "missing_or_invalid_gps"
    assert unavailable["total"] == 0 and unavailable["items"] == []


def test_exact_distance_circle_boundary_and_radius_options(catalog_app):
    client, engine = catalog_app
    degree = math.degrees(1000 / 6_371_008.8)
    source, same, boundary, outside, middle, far, corner = seed(
        engine,
        [
            (0, 0),
            (0, 0),
            (0, degree),
            (0, degree * 1.00001),
            (0, degree * 8),
            (0, degree * 26),
            (degree * 0.9, degree * 0.9),
        ],
    )
    one = nearby(client, source, radius_km=1)
    assert [item["id"] for item in one["items"]] == [same, boundary]
    assert one["items"][0]["distance_m"] == 0
    assert one["items"][1]["distance_m"] == pytest.approx(1000, abs=1e-6)
    assert nearby(client, source)["total"] == 4  # default 5 km
    ten = nearby(client, source, radius_km=10)
    assert {item["id"] for item in ten["items"]} == {
        same,
        boundary,
        outside,
        middle,
        corner,
    }
    assert far not in {
        item["id"] for item in nearby(client, source, radius_km=25)["items"]
    }


@pytest.mark.parametrize(
    "origin",
    [
        (0, 179.999),
        (0, -180),
        (0, 180),
        (-45, -179.99),
        (89.999, -100),
        (-89.999, 170),
        (90, 14),
        (-90, -30),
        (-46, -14),
    ],
)
def test_antimeridian_poles_negative_coordinates_against_reference(catalog_app, origin):
    client, engine = catalog_app
    rng = random.Random(75)
    locations = [origin, origin]
    for _ in range(90):
        lat = origin[0] + rng.uniform(-0.3, 0.3)
        # Reflect across a pole instead of collapsing many points into one.
        if lat > 90:
            lat = 180 - lat
        elif lat < -90:
            lat = -180 - lat
        lon = ((origin[1] + rng.uniform(-0.4, 0.4) + 180) % 360) - 180
        locations.append((lat, lon))
    # Across opposite meridians near a pole is still very close.
    if abs(origin[0]) > 89:
        locations.append((origin[0], (origin[1] + 360) % 360 - 180))
    ids = seed(engine, locations)
    expected = sorted(
        [
            (reference_distance(origin, point), photo_id)
            for point, photo_id in zip(locations[1:], ids[1:], strict=True)
            if reference_distance(origin, point) <= 25_000 + 1e-6
        ]
    )
    body = nearby(client, ids[0], radius_km=25, limit=24)
    assert body["total"] == len(expected)
    # At exact poles, sub-nanometer vector roundoff can reorder physical ties.
    if abs(origin[0]) != 90:
        assert [item["id"] for item in body["items"]] == [
            photo_id for _, photo_id in expected[:24]
        ]
    for item in body["items"]:
        assert item["distance_m"] == pytest.approx(
            reference_distance(origin, locations[ids.index(item["id"])]), abs=1e-6
        )


def test_distance_then_date_nulls_last_then_id_and_limits(catalog_app):
    client, engine = catalog_app
    source = seed(engine, [(0, 0)])[0]
    with Session(engine) as session:
        dated = [None, datetime(2025, 1, 1), datetime(2026, 1, 1), datetime(2026, 1, 1)]
        ids = [
            add_photo(
                session,
                i + 1,
                latitude=0,
                longitude=0,
                captured_at=captured,
                display_title="  Fox  ",
            ).id
            for i, captured in enumerate(dated)
        ]
        farther = add_photo(
            session, 5, latitude=0.001, longitude=0, captured_at=datetime(2026, 2, 1)
        ).id
        for i in range(6, 36):
            add_photo(session, i, latitude=0.002, longitude=0)
        session.commit()
    body = nearby(client, source, limit=24)
    assert body["total"] == 35
    assert len(body["items"]) == 24
    assert len(nearby(client, source)["items"]) == 12
    assert [item["id"] for item in body["items"][:5]] == [
        ids[2],
        ids[3],
        ids[1],
        ids[0],
        farther,
    ]
    assert body["items"][0]["display_title"] == "Fox"
    assert set(body["items"][0]) == {
        "id",
        "display_title",
        "original_filename",
        "thumbnail_filename",
        "captured_at",
        "distance_m",
    }
    assert nearby(client, source, limit=1)["items"] == body["items"][:1]


def test_current_effective_gps_trash_restore_clear_and_permanent_delete(catalog_app):
    client, engine = catalog_app
    source, other = seed(
        engine, [(0, 0), (0, 0)], extracted_latitude=0, extracted_longitude=0
    )

    def edit(photo_id, **values):
        current = client.get(f"/photos/{photo_id}").json()
        response = client.patch(
            f"/photos/{photo_id}",
            params={"expected_updated_at": current["updated_at"]},
            json=values,
        )
        assert response.status_code == 200, response.text

    assert nearby(client, source)["total"] == 1
    assert client.delete(f"/photos/{other}").status_code == 200
    assert nearby(client, source)["total"] == 0
    assert client.post(f"/trash/photos/{other}/restore").status_code == 200
    assert nearby(client, source)["total"] == 1
    edit(other, latitude=1, longitude=1)
    assert nearby(client, source)["total"] == 0
    edit(other, latitude=0, longitude=0)
    assert nearby(client, source)["total"] == 1
    edit(other, latitude=None, longitude=None)
    assert nearby(client, source)["total"] == 0
    edit(other, latitude=0, longitude=0)
    edit(source, latitude=None, longitude=None)
    assert nearby(client, source)["availability"] == "unavailable"
    edit(source, latitude=0, longitude=0)
    assert client.delete(f"/photos/{other}").status_code == 200
    assert client.delete(f"/trash/photos/{other}").status_code == 200
    assert nearby(client, source)["items"] == []


def test_lightweight_batched_candidate_query_and_no_files(catalog_app, monkeypatch):
    client, engine = catalog_app
    source = seed(engine, [(0, 0)])[0]
    # Dense candidates span several batches; farther archive rows must never
    # reach Python distance calculations. Nearest rows are inserted last.
    with engine.begin() as connection:
        connection.execute(
            Photo.__table__.insert(),
            [
                dict(
                    original_filename=f"bulk-{i}.jpg",
                    stored_filename="missing.jpg",
                    resized_filename="missing.jpg",
                    thumbnail_filename="missing.jpg",
                    latitude=0.01 if i < 600 else 50,
                    longitude=0,
                )
                for i in range(1600)
            ],
        )
        connection.execute(
            Photo.__table__.insert(),
            dict(
                original_filename="nearest.jpg",
                stored_filename="missing.jpg",
                resized_filename="missing.jpg",
                thumbnail_filename="missing.jpg",
                latitude=0,
                longitude=0,
            ),
        )
    calls, queries, options = [], [], []

    def distance(*args):
        calls.append(args)
        return great_circle_distance_m(*args)

    def forbid(*args, **kwargs):
        raise AssertionError("Nearby must not hydrate Photos or access image files")

    def sql(_conn, _cursor, statement, _params, context, _many):
        queries.append(statement)
        options.append(context.execution_options)

    monkeypatch.setattr(service, "great_circle_distance_m", distance)
    monkeypatch.setattr(Path, "open", forbid)
    event.listen(Photo, "load", forbid)
    event.listen(engine, "before_cursor_execute", sql)
    try:
        result = nearby(client, source, limit=1)
    finally:
        event.remove(Photo, "load", forbid)
        event.remove(engine, "before_cursor_execute", sql)
    assert result["total"] == 601
    assert result["items"][0]["original_filename"] == "nearest.jpg"
    assert len(calls) == 601
    assert len(queries) == 2
    assert options[1]["yield_per"] == service.CANDIDATE_BATCH_SIZE
    assert "BETWEEN" in queries[1] and "deleted_at IS NULL" in queries[1]
    assert all(
        "photo.tags" not in query and "photo.stored_filename" not in query
        for query in queries
    )
