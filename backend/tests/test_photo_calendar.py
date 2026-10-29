from datetime import datetime

import pytest
from sqlalchemy import event
from sqlmodel import Session

from app.models import Photo
from app.services.catalog import get_photo_calendar
from tests.test_capture_metadata_editing import patch
from tests.test_catalog import add_photo
from tests.test_catalog import catalog_app as catalog_app
from tests.test_photo_lifecycle import lifecycle as lifecycle
from tests.test_photo_lifecycle import metadata_jpeg_bytes, upload


def calendar(client, year=None):
    response = client.get(
        "/catalog/calendar", params={} if year is None else {"year": year}
    )
    assert response.status_code == 200
    body = response.json()
    assert sum(day["photo_count"] for day in body["days"]) == body["photo_count"]
    assert len(body["days"]) == body["active_days"]
    assert body["days"] == sorted(body["days"], key=lambda day: day["date"])
    return body


def test_empty_unknown_and_explicit_empty_year(catalog_app):
    client, engine = catalog_app
    empty = dict(
        year=None,
        available_years=[],
        photo_count=0,
        active_days=0,
        max_daily_count=0,
        days=[],
        unknown_capture_count=0,
    )
    assert calendar(client) == empty
    assert calendar(client, 2026) == {**empty, "year": 2026}
    with Session(engine) as session:
        add_photo(session, 1)
        add_photo(session, 2, deleted_at=datetime(2026, 1, 1))
        session.commit()
    assert calendar(client) == {**empty, "unknown_capture_count": 1}


@pytest.mark.parametrize("year", ["0", "10000", "-1", "2026.5", "nan", "", "abc"])
def test_invalid_year(catalog_app, year):
    client, _ = catalog_app
    assert client.get("/catalog/calendar", params={"year": year}).status_code == 422


@pytest.mark.parametrize("year", [1, 4, 99, 1900, 2000, 2023, 2024, 9999])
def test_year_month_leap_midnight_boundaries_and_catalog_totals(catalog_app, year):
    from calendar import isleap

    client, engine = catalog_app
    dates = [
        datetime(year, 1, 1),
        datetime(year, 1, 31, 23, 59, 59, 999999),
        datetime(year, 2, 1),
        datetime(year, 2, 29 if isleap(year) else 28, 23, 59),
        datetime(year, 3, 1, 0, 1),
        datetime(year, 12, 31, 23, 59, 59, 999999),
    ]
    with Session(engine) as session:
        for index, value in enumerate(dates):
            add_photo(
                session,
                index,
                captured_at=value,
                captured_at_offset_minutes=840 if index % 2 else -720,
            )
        # A second exposure on the same camera-local day, despite opposite offsets.
        add_photo(session, 10, captured_at=dates[3], captured_at_offset_minutes=-720)
        if year > 1:
            add_photo(session, 11, captured_at=datetime(year - 1, 12, 31, 23, 59, 59))
        if year < 9999:
            add_photo(session, 12, captured_at=datetime(year + 1, 1, 1))
        add_photo(session, 13)
        add_photo(session, 14, captured_at=dates[3], deleted_at=datetime(2026, 1, 1))
        session.commit()
    body = calendar(client, year)
    assert body["photo_count"] == 7
    assert body["active_days"] == 6
    assert body["max_daily_count"] == 2
    assert body["unknown_capture_count"] == 1
    assert body["days"][3] == {"date": dates[3].isoformat()[:10], "photo_count": 2}
    assert body["available_years"] == sorted(
        {year, max(1, year - 1), min(9999, year + 1)}
    )
    assert calendar(client)["year"] == min(year + 1, 9999)
    for day in body["days"]:
        catalog = client.get(
            "/catalog/photos",
            params={
                "taken_from": day["date"],
                "taken_to": day["date"],
                "sort": "captured_at",
            },
        )
        assert catalog.status_code == 200
        assert catalog.json()["total"] == day["photo_count"]
    assert (
        client.get(
            "/catalog/photos",
            params={"taken_from": f"{year:04d}-01-01", "taken_to": f"{year:04d}-12-31"},
        ).json()["total"]
        == body["photo_count"]
    )


def test_corrected_capture_trash_restore_and_original_bytes(lifecycle):
    client, _, settings = lifecycle
    photo = upload(client, metadata_jpeg_bytes()).json()
    original = settings.image_dirs["original"] / photo["stored_filename"]
    before = original.read_bytes()
    assert calendar(client)["days"] == [{"date": "2024-05-24", "photo_count": 1}]
    edited = patch(
        client, photo, captured_at="2026-01-01T00:01:00", captured_at_offset_minutes=840
    )
    assert edited.status_code == 200
    assert calendar(client, 2024)["days"] == []
    assert calendar(client)["days"] == [{"date": "2026-01-01", "photo_count": 1}]
    assert client.delete(f"/photos/{photo['id']}").status_code == 200
    assert calendar(client)["year"] is None
    assert client.post(f"/trash/photos/{photo['id']}/restore").status_code == 200
    assert calendar(client)["photo_count"] == 1
    cleared = patch(
        client,
        client.get(f"/photos/{photo['id']}").json(),
        captured_at=None,
        captured_at_offset_minutes=None,
    )
    assert cleared.status_code == 200
    assert calendar(client)["unknown_capture_count"] == 1
    assert calendar(client)["year"] is None
    assert original.read_bytes() == before


def test_bounded_aggregates_no_photo_hydration_and_existing_index(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        for index in range(1000):
            add_photo(session, index, captured_at=datetime(2024, 2, 29, 23, 59))
        session.commit()
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append((statement, parameters))

    def reject_photo(_target, _context):
        pytest.fail("Calendar must not hydrate Photos")

    event.listen(engine, "before_cursor_execute", capture)
    event.listen(Photo, "load", reject_photo)
    try:
        body = calendar(client, 2024)
    finally:
        event.remove(engine, "before_cursor_execute", capture)
        event.remove(Photo, "load", reject_photo)
    assert body["days"] == [{"date": "2024-02-29", "photo_count": 1000}]
    assert len(statements) == 3
    assert set(body["days"][0]) == {"date", "photo_count"}
    statement, parameters = statements[-1]
    with engine.connect() as connection:
        plan = connection.exec_driver_sql(
            "EXPLAIN QUERY PLAN " + statement, parameters
        ).all()
    assert any(
        "ix_photo_catalog_active_captured" in row[3] and "captured_at>?" in row[3]
        for row in plan
    )
    with Session(engine) as session:
        with pytest.raises(ValueError):
            get_photo_calendar(session, 10000)
