from datetime import datetime

import pytest
from pydantic import ValidationError
from sqlalchemy import event, text
from sqlmodel import Session

from app.catalog_query import CatalogSavedQuery
from app.models import Photo
from app.services.metadata_health import get_metadata_health
from tests.test_capture_metadata_editing import gps_metadata_jpeg_bytes, patch
from tests.test_catalog import add_photo, add_taxon
from tests.test_catalog import catalog_app as catalog_app
from tests.test_photo_lifecycle import lifecycle as lifecycle
from tests.test_photo_lifecycle import upload

ISSUES = (
    "missing_capture",
    "missing_gps",
    "missing_both",
    "missing_either",
    "complete",
)


def health(client):
    response = client.get("/catalog/metadata-health")
    assert response.status_code == 200
    body = response.json()
    assert body["missing_either"] + body["complete"] == body["active_total"]
    assert (
        body["missing_capture"] + body["missing_gps"] - body["missing_both"]
        == body["missing_either"]
    )
    for issue in ISSUES:
        result = client.get("/catalog/photos", params={"metadata_issue": issue})
        assert result.status_code == 200
        assert result.json()["total"] == body[issue]
    return body


def test_empty_archive_and_live_only_validation(catalog_app):
    client, _ = catalog_app
    assert health(client) == dict.fromkeys(
        ("active_total", *ISSUES, "completeness_percentage"), 0
    )
    for endpoint in ("photos", "culling", "map"):
        assert (
            client.get(f"/catalog/{endpoint}?metadata_issue=invalid").status_code == 422
        )
    assert client.get("/catalog/map?metadata_issue=missing_gps").status_code == 422
    with pytest.raises(ValidationError):
        CatalogSavedQuery(metadata_issue="complete")


def test_aggregate_matches_lists_and_insights_with_legacy_pairs(catalog_app):
    client, engine = catalog_app
    date = datetime(2026, 5, 1)
    pairs = [
        (0, 0),
        (-90, -180),
        (90, 180),
        (None, 14),
        (46, None),
        (91, 14),
        (46, -181),
        (None, None),
    ]
    with Session(engine) as session:
        session.exec(text("PRAGMA ignore_check_constraints=ON"))
        for index, (lat, lon) in enumerate(pairs, 1):
            add_photo(
                session,
                index,
                captured_at=date if index % 2 else None,
                latitude=None,
                longitude=None,
            )
            session.exec(
                text("UPDATE photo SET latitude=:lat, longitude=:lon WHERE id=:id"),
                params={"lat": lat, "lon": lon, "id": index},
            )
        add_photo(
            session, 9, captured_at=date, latitude=0, longitude=0, deleted_at=date
        )
        # Retained EXIF values and creation/import time cannot fill effective gaps.
        add_photo(
            session,
            10,
            captured_at=None,
            extracted_captured_at=date,
            extracted_latitude=46,
            extracted_longitude=14,
            capture_metadata_overridden=True,
            location_metadata_overridden=True,
        )
        session.commit()
    with engine.connect() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=OFF")
    body = health(client)
    assert body == {
        "active_total": 9,
        "missing_capture": 5,
        "missing_gps": 6,
        "missing_both": 4,
        "missing_either": 7,
        "complete": 2,
        "completeness_percentage": 22.22,
    }
    insights = client.get("/insights").json()["overview"]
    assert insights["gps"]["missing"] == body["missing_gps"]
    assert insights["capture_dates"]["missing"] == body["missing_capture"]
    assert [
        p["id"]
        for p in client.get(
            "/catalog/photos?metadata_issue=complete&sort=name&order=asc"
        ).json()["items"]
    ] == [1, 3]


def test_combined_criteria_pagination_sort_and_count_optimization(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Vulpes vulpes", "Fox")
        for index in range(1, 7):
            add_photo(
                session,
                index,
                taxon=taxon,
                category="mammal",
                tags=["forest", "fox"],
                camera_make="Canon",
                camera_model="R5",
                lens_model="RF100",
                captured_at=datetime(2026, 5, index),
                latitude=0 if index % 2 else None,
                longitude=0 if index % 2 else None,
                display_title=f"Fox {index}",
            )
        taxon_id = taxon.id
        session.commit()
    criteria = {
        "metadata_issue": "missing_gps",
        "category": "mammal",
        "taxon_id": taxon_id,
        "tags": ["forest", "fox"],
        "camera_make": "Canon",
        "camera_model": "R5",
        "lens_model": "RF100",
        "taken_from": "2026-05-02",
        "taken_to": "2026-05-05",
        "search": "Fox",
        "page_size": 1,
        "sort": "captured_at",
        "order": "desc",
    }
    first = client.get("/catalog/photos", params=criteria).json()
    second = client.get("/catalog/photos", params={**criteria, "page": 2}).json()
    assert first["total"] == second["total"] == 2
    assert first["total_pages"] == 2
    assert [first["items"][0]["id"], second["items"][0]["id"]] == [4, 2]
    for filters in (
        {"taxon_id": taxon_id},
        {"search": "Fox"},
        {"taxon_id": taxon_id, "search": "Fox"},
    ):
        assert (
            client.get(
                "/catalog/photos", params={**filters, "metadata_issue": "missing_gps"}
            ).json()["total"]
            == 3
        )
    assert (
        client.get("/catalog/photos", params={**criteria, "tags": ["missing"]}).json()[
            "total"
        ]
        == 0
    )
    cull = client.get(
        "/catalog/culling", params={"metadata_issue": "missing_gps"}
    ).json()
    assert cull["total"] == 3


def test_health_is_one_aggregate_without_photo_hydration(catalog_app):
    _, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, latitude=0, longitude=0)
        session.commit()
    statements = []

    def fail_hydration(*_):
        pytest.fail("Health must not hydrate Photos")

    def record(_conn, _cursor, statement, *_):
        statements.append(statement)

    event.listen(Photo, "load", fail_hydration)
    event.listen(engine, "before_cursor_execute", record)
    try:
        with Session(engine) as session:
            assert get_metadata_health(session).missing_gps == 0
    finally:
        event.remove(Photo, "load", fail_hydration)
        event.remove(engine, "before_cursor_execute", record)
    assert len(statements) == 1 and "count(" in statements[0].lower()


def test_effective_corrections_restore_trash_and_concurrency(lifecycle):
    client, engine, settings = lifecycle
    original = upload(client, gps_metadata_jpeg_bytes()).json()
    path = settings.image_dirs["original"] / original["stored_filename"]
    original_bytes = path.read_bytes()
    before_state = {
        key: original[key]
        for key in ("status", "reviewed_at", "animal_id", "category", "tags")
    }
    assert health(client)["complete"] == 1
    cleared = patch(
        client,
        original,
        captured_at=None,
        captured_at_offset_minutes=None,
        latitude=None,
        longitude=None,
    ).json()
    assert health(client)["missing_both"] == 1
    assert patch(client, original, latitude=0, longitude=0).status_code == 409
    gps = patch(client, cleared, latitude=0, longitude=0).json()
    assert health(client)["missing_capture"] == 1
    assert health(client)["missing_gps"] == 0
    dated = patch(
        client, gps, captured_at="2026-05-02T12:00:00", captured_at_offset_minutes=None
    ).json()
    assert health(client)["complete"] == 1
    # A stale extracted snapshot is not trusted during original restoration.
    with Session(engine) as session:
        session.exec(
            text("UPDATE photo SET extracted_latitude=89, extracted_longitude=179")
        )
        session.commit()
    restored_response = patch(client, dated, restore_original_metadata=True)
    assert restored_response.status_code == 200
    restored = restored_response.json()
    assert restored["latitude"] == 46 and restored["longitude"] == 14
    assert restored["captured_at"] == original["captured_at"]
    assert (
        not restored["capture_metadata_overridden"]
        and not restored["location_metadata_overridden"]
    )
    assert {key: restored[key] for key in before_state} == before_state
    assert health(client)["complete"] == 1
    assert client.delete(f"/photos/{original['id']}").status_code == 200
    assert health(client)["active_total"] == 0
    assert client.post(f"/trash/photos/{original['id']}/restore").status_code == 200
    assert health(client)["complete"] == 1
    assert path.read_bytes() == original_bytes
