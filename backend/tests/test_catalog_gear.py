from datetime import UTC, date, datetime
from time import perf_counter

import pytest
from sqlalchemy import event, text
from sqlmodel import Session

from app.models import ArchiveEvent, ArchiveEventPhoto, ImportSession, Photo
from app.services.catalog import get_catalog_gear
from tests.test_catalog import add_photo, add_taxon
from tests.test_catalog import catalog_app as catalog_app


def test_empty_and_unknown(catalog_app):
    client, engine = catalog_app
    data = client.get("/catalog/gear").json()
    assert data == dict(
        active_total=0,
        distinct_camera_models=0,
        distinct_lens_models=0,
        unknown_camera_count=0,
        unknown_lens_count=0,
        cameras=[],
        lenses=[],
        camera_total=0,
        lens_total=0,
        page=1,
        page_size=100,
    )
    with Session(engine) as session:
        add_photo(session, 1)
        add_photo(session, 2, camera_make="\t\u2003", camera_model=" ", lens_model="\n")
        session.commit()
    data = client.get("/catalog/gear").json()
    assert (
        data["active_total"]
        == data["unknown_camera_count"]
        == data["unknown_lens_count"]
        == 2
    )
    assert data["cameras"] == data["lenses"] == []
    assert (
        client.get(
            "/catalog/photos", params={"unknown_camera": True, "unknown_lens": True}
        ).json()["total"]
        == 2
    )


def test_groups_partial_identities_exact_filters_and_lifecycle(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(
            session,
            1,
            camera_make=" Canon\t",
            camera_model="\u2003Canon EOS R5 ",
            lens_model=" RF100-500mm\n",
        )
        add_photo(
            session,
            2,
            camera_make="Canon",
            camera_model="Canon EOS R5",
            lens_model="RF100-500mm",
        )
        add_photo(session, 3, camera_make="Canon", camera_model=" ", lens_model=None)
        add_photo(session, 4, camera_model="Canon EOS R5", lens_model="RF100-500mm II")
        add_photo(
            session,
            5,
            camera_make="canon",
            camera_model="Canon EOS R50",
            lens_model="100%_x",
        )
        add_photo(session, 6)
        add_photo(session, 7, camera_make="Trashed", deleted_at=datetime.now(UTC))
        session.commit()
    data = client.get("/catalog/gear").json()
    assert data["active_total"] == 6
    assert data["distinct_camera_models"] == 2
    assert data["distinct_lens_models"] == 3
    assert data["unknown_camera_count"] == 1
    assert data["unknown_lens_count"] == 2
    assert data["camera_total"] == 4
    for camera in data["cameras"]:
        assert camera["percentage"] == pytest.approx(camera["count"] * 100 / 6)
        params = {
            field: camera[field] or "" for field in ("camera_make", "camera_model")
        }
        assert (
            client.get("/catalog/photos", params=params).json()["total"]
            == camera["count"]
        )
    for lens in data["lenses"]:
        assert lens["percentage"] == pytest.approx(lens["count"] * 100 / 6)
        assert (
            client.get(
                "/catalog/photos", params={"lens_model": lens["lens_model"]}
            ).json()["total"]
            == lens["count"]
        )
    for criteria, count in [
        ({"camera_make": " Canon "}, 3),
        ({"camera_model": "Canon EOS R5"}, 3),
        ({"lens_model": "RF100-500mm"}, 2),
        ({"camera_model": "EOS R5"}, 0),
        ({"camera_make": "Canon", "unknown_lens": True}, 1),
        ({"camera_make": "canon"}, 1),
        ({"camera_model": "Canon EOS R5", "lens_model": "RF100-500mm II"}, 1),
    ]:
        assert client.get("/catalog/photos", params=criteria).json()["total"] == count
        assert client.get("/catalog/culling", params=criteria).json()["total"] == count
    assert (
        client.get("/catalog/gear", params={"search": "%_"}).json()["lens_total"] == 1
    )
    assert client.delete("/photos/1").status_code == 200
    assert client.get("/catalog/gear").json()["active_total"] == 5
    assert client.post("/trash/photos/1/restore").status_code == 200
    assert client.get("/catalog/gear").json() == data
    with Session(engine) as session:
        assert session.get(Photo, 1).camera_make == " Canon\t"


@pytest.mark.parametrize(
    "criteria",
    [
        {"camera_make": "Canon", "unknown_camera": True},
        {"camera_model": "R5", "unknown_camera": True},
        {"camera_make": "", "unknown_camera": True},
        {"lens_model": "RF", "unknown_lens": True},
        {"camera_model": "x" * 1001},
    ],
)
def test_contradictions_and_map_rejected(catalog_app, criteria):
    client, _ = catalog_app
    for endpoint in ("photos", "culling", "map"):
        assert client.get(f"/catalog/{endpoint}", params=criteria).status_code == 422


def test_combined_filters_counts_pagination_and_culling(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Gear bird")
        for i in range(1, 5):
            add_photo(
                session,
                i,
                camera_make="Canon",
                camera_model="R5",
                lens_model="RF" if i < 3 else "RF II",
                tags=["bird"],
                category="bird",
                taxon=taxon,
                is_favorite=True,
                rating=4,
                culling_state="pick",
                captured_at=datetime(2026, 1, 2),
            )
        taxon_id = taxon.id
        session.commit()
    criteria = dict(
        camera_model="R5",
        lens_model="RF",
        search="bird",
        tags="bird",
        category="bird",
        taxon_id=taxon_id,
        favorites_only=True,
        rating_min=4,
        culling_state="pick",
        status="pending",
        taken_from="2026-01-01",
        taken_to="2026-01-03",
    )
    page = client.get(
        "/catalog/photos",
        params={**criteria, "page_size": 1, "sort": "name", "order": "asc"},
    ).json()
    assert page["total"] == page["total_pages"] == 2
    assert page["items"][0]["id"] == 1
    assert (
        client.get(
            "/catalog/photos",
            params={
                **criteria,
                "page_size": 1,
                "page": 2,
                "sort": "name",
                "order": "asc",
            },
        ).json()["items"][0]["id"]
        == 2
    )
    assert client.get("/catalog/culling", params=criteria).json()["total"] == 2
    # Exercise optimized broad-search/taxon count branches as well.
    for extra in (
        {"search": "bird"},
        {"taxon_id": taxon_id},
        {"search": "bird", "taxon_id": taxon_id},
    ):
        assert (
            client.get("/catalog/photos", params={"lens_model": "RF", **extra}).json()[
                "total"
            ]
            == 2
        )


def test_aggregation_bounded_deterministic_sql_only(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        session.execute(
            text("""WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
            INSERT INTO photo (original_filename, stored_filename, resized_filename, thumbnail_filename,
              status, created_at, updated_at, camera_make, camera_model, lens_model)
            SELECT 'x', 'x', 'x', 'x', 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
              'Make', 'Model ' || (i % 250), 'Lens ' || (i % 250) FROM n""")
        )
        session.commit()
    statements = []

    def record(*args):
        statements.append(args[2])

    def no_hydration(*args):
        raise AssertionError("aggregation hydrated a Photo")

    event.listen(engine, "before_cursor_execute", record)
    event.listen(Photo, "load", no_hydration)
    try:
        start = perf_counter()
        with Session(engine) as session:
            data = get_catalog_gear(session, page_size=7, sort="count")
        assert perf_counter() - start < 5
        assert len(statements) == 4
        assert data["active_total"] == 10000
        assert data["camera_total"] == data["lens_total"] == 250
        assert len(data["cameras"]) == len(data["lenses"]) == 7
        assert data["cameras"][0]["camera_model"] == "Model 0"
    finally:
        event.remove(engine, "before_cursor_execute", record)
        event.remove(Photo, "load", no_hydration)
    first = client.get("/catalog/gear", params={"page_size": 7}).json()
    second = client.get("/catalog/gear", params={"page_size": 7, "page": 2}).json()
    assert not {row["camera_model"] for row in first["cameras"]} & {
        row["camera_model"] for row in second["cameras"]
    }
    assert client.get("/catalog/gear", params={"page_size": 201}).status_code == 422
    assert (
        client.post(
            "/smart-collections",
            json={"name": "Gear", "query_version": 1, "query": {"camera_model": "R5"}},
        ).status_code
        == 422
    )


def test_equipment_intersects_import_and_event_membership(catalog_app):
    client, engine = catalog_app
    import_id = "f649094f-3fab-4a49-84ef-ed2084c4ff41"
    with Session(engine) as session:
        session.add(ImportSession(id=import_id, source_kind="browser"))
        trip = ArchiveEvent(
            kind="trip",
            title="Gear trip",
            start_date=date(2026, 1, 1),
            end_date=date(2026, 1, 3),
        )
        session.add(trip)
        session.flush()
        first = add_photo(
            session, 1, camera_model="R5", lens_model="RF", import_session_id=import_id
        )
        second = add_photo(
            session,
            2,
            camera_model="R5",
            lens_model="RF II",
            import_session_id=import_id,
        )
        add_photo(
            session, 3, camera_model="R5", lens_model="RF", import_session_id=import_id
        )
        for photo in (first, second):
            session.add(ArchiveEventPhoto(event_id=trip.id, photo_id=photo.id))
        trip_id, first_id = trip.id, first.id
        session.commit()
    criteria = dict(
        camera_model="R5",
        lens_model="RF",
        import_session_id=import_id,
        event_id=trip_id,
    )
    data = client.get("/catalog/photos", params=criteria).json()
    assert data["total"] == 1 and data["items"][0]["id"] == first_id
    culling = client.get("/catalog/culling", params=criteria).json()
    assert culling["total"] == 1 and culling["photo"]["id"] == first_id
