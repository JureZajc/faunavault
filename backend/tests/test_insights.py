from datetime import datetime

import pytest
from sqlalchemy import event, text
from sqlmodel import Session

from app.models import Animal
from app.services.insights import get_insights
from tests.test_catalog import add_photo, add_taxon
from tests.test_catalog import catalog_app as catalog_app


def reconcile(body):
    total = body["overview"]["total_photos"]
    assert sum(row["photo_count"] for row in body["categories"]) == total
    assert sum(row["photo_count"] for row in body["classification"]) == total
    for name in ("gps", "capture_dates"):
        coverage = body["overview"][name]
        assert coverage["known"] + coverage["missing"] == total
        assert coverage["percentage"] == (
            round(coverage["known"] / total * 100, 2) if total else 0
        )
    for name in ("camera", "lens"):
        coverage = body["equipment"][name]
        assert coverage["known"] + coverage["missing"] == total
        assert coverage["percentage"] == (
            round(100 * coverage["known"] / total, 2) if total else 0
        )
    for name in ("top_cameras", "top_lenses"):
        assert len(body["equipment"][name]) <= 10
        for equipment in body["equipment"][name]:
            assert equipment["percentage"] == round(
                100 * equipment["photo_count"] / total, 2
            )
    assert (
        sum(row["photo_count"] for row in body["yearly"])
        == body["overview"]["capture_dates"]["known"]
    )
    if body["year"] is not None:
        assert len(body["monthly"]) == 12
        assert [row["period"] for row in body["monthly"]] == list(range(1, 13))
        assert sum(row["photo_count"] for row in body["monthly"]) == total


def test_empty_unknown_and_invalid_years(catalog_app):
    client, _ = catalog_app
    for year in (None, 1, 2026, 9999):
        response = client.get(
            "/insights", params={} if year is None else {"year": year}
        )
        assert response.status_code == 200
        body = response.json()
        assert body["overview"]["total_photos"] == 0
        assert body["overview"]["verified_species"] == 0
        assert body["available_years"] == body["top_species"] == []
        assert body["equipment"]["top_cameras"] == []
        assert body["equipment"]["top_lenses"] == []
        reconcile(body)
    for value in (0, -1, 10000, "oops", "2026.5", ""):
        assert client.get("/insights", params={"year": value}).status_code == 422


def test_active_scope_boundaries_capture_dates_and_gps(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        for index, capture in enumerate(
            (
                datetime(2025, 12, 31, 23, 59, 59),
                datetime(2026, 1, 1),
                datetime(2026, 12, 31, 23, 59, 59),
                datetime(2027, 1, 1),
                None,
            ),
            1,
        ):
            add_photo(
                session,
                index,
                captured_at=capture,
                category=None if index % 2 else "bird",
                status=("pending", "classified", "needs_review")[index % 3],
                latitude=0 if index == 2 else None,
                longitude=0 if index == 2 else None,
                captured_at_offset_minutes=-600 if index == 2 else None,
                is_favorite=index == 2,
                culling_state="pick"
                if index == 2
                else "reject"
                if index == 3
                else None,
            )
        add_photo(
            session,
            6,
            captured_at=datetime(2026, 6, 1),
            deleted_at=datetime(2026, 8, 1),
            is_favorite=True,
            latitude=90,
            longitude=180,
        )
        session.commit()
    all_time = client.get("/insights").json()
    assert all_time["overview"]["total_photos"] == 5
    assert all_time["overview"]["capture_dates"] == {
        "known": 4,
        "missing": 1,
        "percentage": 80,
    }
    assert all_time["available_years"] == [2025, 2026, 2027]
    assert all_time["monthly"] == []
    reconcile(all_time)
    scoped = client.get("/insights?year=2026").json()
    assert scoped["overview"]["total_photos"] == 2
    assert scoped["overview"]["gps"] == {"known": 1, "missing": 1, "percentage": 50}
    assert (
        scoped["overview"]["favorites"]
        == scoped["overview"]["picks"]
        == scoped["overview"]["rejects"]
        == 1
    )
    assert (
        scoped["monthly"][0]["photo_count"] == scoped["monthly"][-1]["photo_count"] == 1
    )
    assert all(row["photo_count"] == 0 for row in scoped["monthly"][1:-1])
    assert scoped["available_years"] == [2025, 2026, 2027]
    reconcile(scoped)


def test_species_counts_photos_across_animals_and_excludes_guesses_and_other_ranks(
    catalog_app,
):
    client, engine = catalog_app
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes", "Red fox")
        owl = add_taxon(session, "Strix aluco")
        genus = add_taxon(session, "Vulpes")
        genus.taxonomic_rank = "GENUS"
        first = add_photo(session, 1, taxon=fox)
        add_photo(session, 2, taxon=fox)
        shared = add_photo(session, 3)
        shared.animal_id = first.animal_id
        add_photo(session, 4, taxon=owl)
        add_photo(session, 5, taxon=genus)
        add_photo(session, 6, species_guess="Vulpes vulpes")
        absent = add_photo(session, 7)
        absent.animal_id = None
        add_photo(session, 8, taxon=owl, deleted_at=datetime(2026, 1, 1))
        session.commit()
    body = client.get("/insights").json()
    assert body["overview"]["verified_species"] == 2
    assert body["overview"]["unverified_photos"] == 2
    assert body["overview"]["other_taxon_rank_photos"] == 1
    assert [
        (row["scientific_name"], row["photo_count"]) for row in body["top_species"]
    ] == [("Vulpes vulpes", 3), ("Strix aluco", 1)]
    assert body["top_species"][0]["percentage"] == 42.86
    for species in body["top_species"]:
        listing = client.get(
            "/catalog/photos", params={"taxon_id": species["taxon_id"]}
        ).json()
        assert listing["total"] == species["photo_count"]
    reconcile(body)


def test_bounded_rankings_categories_and_deterministic_ties(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        for index in range(25):
            taxon = add_taxon(session, f"Species {24 - index:02}")
            add_photo(session, index, taxon=taxon, category=f"category-{index:02}")
        for index, category in enumerate((None, "", "   "), 30):
            add_photo(session, index, category=category)
        session.commit()
    body = client.get("/insights").json()
    assert len(body["top_species"]) == 10
    assert body["overview"]["verified_species"] == 25
    assert [row["scientific_name"] for row in body["top_species"]] == [
        f"Species {index:02}" for index in range(10)
    ]
    assert len(body["categories"]) == 22
    assert body["categories"][-2]["label"] == "Uncategorized"
    assert body["categories"][-2]["photo_count"] == 3
    assert body["categories"][-1]["photo_count"] == 5
    reconcile(body)


def test_effective_metadata_edits_trash_and_restore_are_live(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Vulpes vulpes")
        photo = add_photo(
            session,
            1,
            taxon=taxon,
            captured_at=datetime(2025, 12, 31),
            extracted_captured_at=datetime(2025, 12, 31),
            camera_make="Canon",
            camera_model="R5",
            lens_model="RF100",
        )
        photo_id = photo.id
        animal_id = photo.animal_id
        session.commit()
    assert client.get("/insights?year=2025").json()["overview"]["total_photos"] == 1
    result = client.patch(
        f"/photos/{photo_id}",
        params={
            "expected_updated_at": client.get(f"/photos/{photo_id}").json()[
                "updated_at"
            ],
        },
        json={
            "captured_at": "2026-01-01T00:15:00",
            "captured_at_offset_minutes": None,
            "latitude": 46.0,
            "longitude": 14.0,
            "is_favorite": True,
            "culling_state": "pick",
            "category": "bird",
        },
    )
    assert result.status_code == 200, result.text
    body = client.get("/insights?year=2026").json()
    assert (
        body["overview"]["total_photos"]
        == body["overview"]["gps"]["known"]
        == body["overview"]["favorites"]
        == 1
    )
    assert client.get("/insights?year=2025").json()["overview"]["total_photos"] == 0
    assert body["available_years"] == [2026]
    assert body["equipment"]["top_cameras"][0]["photo_count"] == 1
    assert body["equipment"]["top_lenses"][0]["photo_count"] == 1
    assert client.get("/insights?year=2025").json()["equipment"]["top_cameras"] == []
    reconcile(body)
    assert client.delete(f"/photos/{photo_id}").status_code == 200
    assert client.get("/insights").json()["overview"]["total_photos"] == 0
    assert client.get("/insights").json()["equipment"]["top_cameras"] == []
    assert client.post(f"/trash/photos/{photo_id}/restore").status_code == 200
    assert client.get("/insights").json()["overview"]["verified_species"] == 1
    assert client.get("/insights").json()["equipment"]["camera"]["known"] == 1
    with Session(engine) as session:
        animal = session.get(Animal, animal_id)
        animal.taxon_id = None
        session.add(animal)
        session.commit()
    assert client.get("/insights").json()["overview"]["verified_species"] == 0


@pytest.mark.parametrize("year, expected_queries", [(None, 7), (2026, 8)])
def test_query_count_projection_and_legacy_incomplete_gps(
    catalog_app, year, expected_queries
):
    _, engine = catalog_app
    with Session(engine) as session:
        for index in range(150):
            add_photo(session, index, captured_at=datetime(2026, 2, 1))
        session.commit()
        # Emulate an old archive's incomplete pair without model event validation.
        session.exec(text("UPDATE photo SET latitude = 46 WHERE id = 1"))
        session.commit()
    statements = []

    def record(_connection, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        with Session(engine) as session:

            def forbid_hydration(_session, _instance):
                pytest.fail("Insights must not hydrate ORM entities")

            event.listen(session, "loaded_as_persistent", forbid_hydration)
            result = get_insights(session, year)
            assert len(session.identity_map) == 0
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len(statements) == expected_queries
    assert all("count(" in statement.lower() for statement in statements)
    assert result.overview.gps.known == 0
    assert result.overview.gps.missing == 150
    assert result.equipment.camera.missing == result.equipment.lens.missing == 150
    reconcile(result.model_dump())


@pytest.mark.parametrize("year", [1, 9999])
def test_extreme_calendar_years(catalog_app, year):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, captured_at=datetime(year, 12, 31, 23, 59, 59))
        session.commit()
    body = client.get(f"/insights?year={year}").json()
    assert body["overview"]["total_photos"] == 1
    assert body["monthly"][-1]["photo_count"] == 1
    reconcile(body)


def test_equipment_partial_exact_identities_unknowns_and_scoped_links(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes")
        values = [
            ("Canon", "R5", "RF100", datetime(2024, 2, 29, 23, 59)),
            ("Canon", "R5", "RF100", datetime(2024, 1, 1)),
            (None, "R5", "rf100", datetime(2024, 12, 31, 23, 59)),
            ("Canon", None, None, datetime(2024, 3, 1)),
            (None, None, None, datetime(2024, 6, 1)),
            ("\t\u2003", " ", "\n\t", datetime(2024, 7, 1)),
            ("canon", "R5", "RF100", datetime(2025, 1, 1)),
            ("Other", "R5", "RF100", None),
        ]
        for index, (make, model, lens, capture) in enumerate(values, 1):
            add_photo(
                session,
                index,
                camera_make=make,
                camera_model=model,
                lens_model=lens,
                captured_at=capture,
                captured_at_offset_minutes=840 if capture else None,
                taxon=fox,
                is_favorite=index == 1,
                culling_state="pick" if index == 1 else "reject",
            )
        trashed = add_photo(
            session,
            9,
            camera_make="Trash",
            camera_model="Excluded",
            lens_model="Trash",
            captured_at=datetime(2024, 2, 29),
            deleted_at=datetime(2026, 1, 1),
        )
        trashed_id = trashed.id
        session.commit()
    body = client.get("/insights?year=2024").json()
    gear = body["equipment"]
    assert body["overview"]["total_photos"] == 6
    assert body["overview"]["verified_species"] == 1
    assert gear["camera"] == {"known": 4, "missing": 2, "percentage": 66.67}
    assert gear["lens"] == {"known": 3, "missing": 3, "percentage": 50}
    assert gear["top_cameras"][0] == {
        "camera_make": "Canon",
        "camera_model": "R5",
        "photo_count": 2,
        "percentage": 33.33,
    }
    assert [
        (row["camera_make"], row["camera_model"]) for row in gear["top_cameras"][1:]
    ] == [("Canon", None), (None, "R5")]
    assert [row["lens_model"] for row in gear["top_lenses"]] == ["RF100", "rf100"]
    reconcile(body)
    # Each chart row drills down to exactly its count, preserving the year and
    # explicitly filtering missing components of partial camera identities.
    base = {"taken_from": "2024-01-01", "taken_to": "2024-12-31"}
    for row in gear["top_cameras"]:
        result = client.get(
            "/catalog/photos",
            params={
                **base,
                "camera_make": row["camera_make"] or "",
                "camera_model": row["camera_model"] or "",
            },
        ).json()
        assert result["total"] == row["photo_count"]
    for row in gear["top_lenses"]:
        assert (
            client.get(
                "/catalog/photos", params={**base, "lens_model": row["lens_model"]}
            ).json()["total"]
            == row["photo_count"]
        )
    for kind in ("camera", "lens"):
        assert (
            client.get(
                "/catalog/photos", params={**base, f"unknown_{kind}": True}
            ).json()["total"]
            == gear[kind]["missing"]
        )
    all_time = client.get("/insights").json()
    assert all_time["overview"]["total_photos"] == 8
    assert all_time["equipment"]["camera"]["known"] == 6
    reconcile(all_time)
    assert client.post(f"/trash/photos/{trashed_id}/restore").status_code == 200
    restored = client.get("/insights?year=2024").json()
    assert restored["equipment"]["camera"]["known"] == 5
    assert restored["equipment"]["lens"]["known"] == 4
    reconcile(restored)


def test_equipment_top_ten_ties_and_case_sensitive_stored_values(catalog_app):
    client, engine = catalog_app
    names = ["a", "A", "b", "B"] + [f"Camera {index:02}" for index in range(12)]
    with Session(engine) as session:
        for index, name in enumerate(reversed(names), 1):
            add_photo(
                session, index, camera_make=name, camera_model="Model", lens_model=name
            )
        add_photo(session, 100, camera_make="Z", camera_model="Winner", lens_model="Z")
        add_photo(session, 101, camera_make="Z", camera_model="Winner", lens_model="Z")
        session.commit()
    gear = client.get("/insights").json()["equipment"]
    expected = ["Z"] + sorted(names, key=lambda name: (name.lower(), name))[:9]
    assert [row["camera_make"] for row in gear["top_cameras"]] == expected
    assert [row["lens_model"] for row in gear["top_lenses"]] == expected
    assert gear["camera"]["known"] == gear["lens"]["known"] == 18
    assert gear["top_cameras"][0]["photo_count"] == 2
    assert gear["top_lenses"][0]["percentage"] == 11.11


def test_camera_identity_never_guesses_manufacturer_from_model(catalog_app):
    client, engine = catalog_app
    pairs = [
        ("Canon", "Canon R5"),
        (None, "Canon R5"),
        ("Canon", "R5"),
        ("Canon R5", None),
    ]
    with Session(engine) as session:
        for index, (make, model) in enumerate(pairs, 1):
            add_photo(session, index, camera_make=make, camera_model=model)
        session.commit()
    gear = client.get("/insights").json()["equipment"]
    assert gear["camera"] == {"known": 4, "missing": 0, "percentage": 100}
    assert gear["lens"] == {"known": 0, "missing": 4, "percentage": 0}
    assert gear["top_lenses"] == []
    assert [
        (row["camera_make"], row["camera_model"]) for row in gear["top_cameras"]
    ] == [pairs[index] for index in (0, 1, 2, 3)]
    assert all(
        row["photo_count"] == 1 and row["percentage"] == 25
        for row in gear["top_cameras"]
    )
