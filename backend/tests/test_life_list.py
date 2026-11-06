# ruff: noqa: F811
from datetime import datetime

import pytest
from sqlalchemy import event
from sqlmodel import Session

from app.models import Photo, Sighting, SightingPhoto
from tests.test_catalog import add_taxon
from tests.test_collections import collections_app, seed_photos  # noqa: F401
from tests.test_photo_lifecycle import jpeg_bytes
from tests.test_sightings import create

URL = "/sightings/life-list"


def life_list(client, **params):
    response = client.get(URL, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_empty_life_list_and_validation(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    create(client, ids, subject_label="Possible fox")
    assert life_list(client) == {
        "items": [],
        "total": 0,
        "page": 1,
        "page_size": 24,
        "total_pages": 0,
        "year": None,
        "available_years": [],
        "summary": {
            "all_time_taxa": 0,
            "all_time_sightings": 0,
            "seen_taxa": None,
            "new_taxa": None,
            "scope_sightings": 0,
        },
    }
    assert life_list(client, year=2026)["summary"]["seen_taxa"] == 0
    for params in (
        {"year": 0},
        {"year": 10000},
        {"year": "2026.1"},
        {"mode": "any"},
        {"sort": "latest"},
        {"page": 0},
        {"page_size": 101},
        {"search": "x" * 201},
    ):
        assert client.get(URL, params=params).status_code == 422


def test_one_encounter_uses_observed_at_and_counts_once_for_many_photos(
    collections_app,
):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=3)
    with Session(engine) as session:
        taxon_id = add_taxon(session, "Vulpes vulpes", "Red fox").id
        for photo_id in ids:
            session.get(Photo, photo_id).captured_at = datetime(2023, 1, 1)
        session.commit()
    item = create(
        client,
        ids[::-1],
        taxon_id=taxon_id,
        observed_at="2025-01-01T00:05:00",
        observed_at_offset_minutes=120,
    )
    result = life_list(client, year=2025)
    assert result["available_years"] == [2025]
    assert result["summary"] == {
        "all_time_taxa": 1,
        "all_time_sightings": 1,
        "seen_taxa": 1,
        "new_taxa": 1,
        "scope_sightings": 1,
    }
    assert result["items"] == [
        {
            "taxon_id": taxon_id,
            "common_name": "Red fox",
            "scientific_name": "Vulpes vulpes",
            "taxonomic_rank": "SPECIES",
            "sighting_count": 1,
            "first_observed_at": item["observed_at"],
            "last_observed_at": item["observed_at"],
            "first_sighting_id": item["id"],
            "last_sighting_id": item["id"],
            "preview": item["preview"],
        }
    ]
    assert life_list(client, year=2024)["items"] == []


def test_year_modes_rank_and_timestamp_ties(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes", "Fox").id
        subspecies = add_taxon(session, "Vulpes vulpes vulpes", "Fox")
        subspecies.taxonomic_rank = "subspecies"
        subspecies_id = subspecies.id
        genus = add_taxon(session, "Vulpes")
        genus.taxonomic_rank = "GENUS"
        session.add(Sighting(taxon_id=genus.id, observed_at=datetime(2030, 1, 1)))
        session.commit()
    later = create(client, ids, taxon_id=fox, observed_at="2026-08-04T12:30:00")
    first = create(client, ids, taxon_id=fox, observed_at="2025-09-04T11:30:00")
    create(client, ids, taxon_id=fox, observed_at=first["observed_at"])
    create(client, ids, taxon_id=fox, observed_at=later["observed_at"])
    create(client, ids, taxon_id=subspecies_id, observed_at=later["observed_at"])
    create(client, ids, observed_at="2027-01-01T01:00:00")
    seen = life_list(client, year=2026)
    assert seen["available_years"] == [2026, 2025]
    assert seen["summary"] == {
        "all_time_taxa": 2,
        "all_time_sightings": 5,
        "seen_taxa": 2,
        "new_taxa": 1,
        "scope_sightings": 3,
    }
    species_row, subspecies_row = seen["items"]
    assert species_row["taxon_id"] == fox and species_row["sighting_count"] == 4
    assert species_row["first_observed_at"] == first["observed_at"]
    assert species_row["last_observed_at"] == later["observed_at"]
    assert species_row["first_sighting_id"] == first["id"]
    assert species_row["last_sighting_id"] == later["id"]
    assert subspecies_row["taxon_id"] == subspecies_id
    assert subspecies_row["taxonomic_rank"].upper() == "SUBSPECIES"
    new = life_list(client, year=2026, mode="new")
    assert new["items"] == [subspecies_row]
    assert new["summary"] == {**seen["summary"], "scope_sightings": 1}
    assert life_list(client, mode="new")["total"] == 2


@pytest.mark.parametrize(
    ("year", "observed_at"),
    [(1, "0001-01-01T00:00:00"), (9999, "9999-12-31T23:59:59.999999")],
)
def test_observation_year_boundaries(collections_app, year, observed_at):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    with Session(engine) as session:
        identity = add_taxon(session, "Vulpes vulpes").id
        session.commit()
    create(client, ids, taxon_id=identity, observed_at=observed_at)
    result = life_list(client, year=year, mode="new")
    assert result["available_years"] == [year]
    assert result["summary"]["seen_taxa"] == result["summary"]["new_taxa"] == 1
    assert result["items"][0]["first_observed_at"] == observed_at


def test_search_sorting_and_pagination(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes", "Rdeča lisica").id
        owl = add_taxon(session, "Tyto alba", "Barn owl").id
        raven = add_taxon(session, "Corvus corax", "Raven").id
        session.commit()
    create(client, ids, taxon_id=fox, observed_at="2025-02-02T10:00:00")
    create(client, ids, taxon_id=owl, observed_at="2025-03-03T10:00:00")
    for _ in range(2):
        create(client, ids, taxon_id=raven, observed_at="2025-04-04T10:00:00")
    for sort, expected in (
        ("name", [owl, raven, fox]),
        ("first_observed", [fox, owl, raven]),
        ("most_observed", [raven, fox, owl]),
    ):
        assert [
            row["taxon_id"] for row in life_list(client, sort=sort)["items"]
        ] == expected
    for search in ("  RDEČA ", "vULPes"):
        result = life_list(client, search=search, year=2025, mode="new")
        assert [row["taxon_id"] for row in result["items"]] == [fox]
        assert result["summary"] == {
            "all_time_taxa": 3,
            "all_time_sightings": 4,
            "seen_taxa": 3,
            "new_taxa": 3,
            "scope_sightings": 1,
        }
    assert life_list(client, search="%_")["total"] == 0
    second = life_list(client, page=2, page_size=1)
    assert (
        second["page"],
        second["page_size"],
        second["total"],
        second["total_pages"],
    ) == (2, 1, 3, 3)
    assert (
        second["items"][0]["taxon_id"] == raven
        and second["summary"]["scope_sightings"] == 4
    )
    assert life_list(client, page=4, page_size=1)["items"] == []


def test_date_and_taxon_edits_and_deletion_take_effect_on_next_fetch(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes").id
        owl = add_taxon(session, "Tyto alba").id
        session.commit()
    first = create(client, ids, taxon_id=fox, observed_at="2025-01-01T00:00:00")
    later = create(client, ids, taxon_id=fox, observed_at="2026-01-01T00:00:00")
    first_url = f"/sightings/{first['id']}"
    assert life_list(client, year=2026, mode="new")["total"] == 0
    assert (
        client.patch(first_url, json={"observed_at": "2027-01-01T00:00:00"}).status_code
        == 200
    )
    row = life_list(client, year=2026, mode="new")["items"][0]
    assert (row["first_sighting_id"], row["last_sighting_id"]) == (
        later["id"],
        first["id"],
    )
    assert client.patch(first_url, json={"taxon_id": owl}).status_code == 200
    assert life_list(client)["summary"]["all_time_taxa"] == 2
    assert client.delete(first_url).status_code == 200
    result = life_list(client)
    assert (
        result["summary"]["all_time_taxa"]
        == result["summary"]["all_time_sightings"]
        == 1
    )
    assert result["available_years"] == [2026]


def test_trash_restore_and_active_thumbnail_fallback(collections_app):
    client, engine, _ = collections_app
    with Session(engine) as session:
        identity = add_taxon(session, "Vulpes vulpes").id
        session.commit()
    photos = []
    for color in ("green", "red"):
        response = client.post(
            "/photos/upload",
            data={"allow_visual_duplicate": "true"},
            files={"file": (f"{color}.jpg", jpeg_bytes(color), "image/jpeg")},
        )
        assert response.status_code == 200, response.text
        photos.append(response.json()["id"])
    early = create(
        client, [photos[0]], taxon_id=identity, observed_at="2025-01-01T00:00:00"
    )
    create(client, [photos[1]], taxon_id=identity, observed_at="2026-01-01T00:00:00")
    assert life_list(client, year=2026)["items"][0]["preview"]["id"] == photos[0]
    assert client.delete(f"/photos/{photos[0]}").status_code == 200
    assert life_list(client)["items"][0]["preview"]["id"] == photos[1]
    assert client.delete(f"/photos/{photos[1]}").status_code == 200
    item = life_list(client)["items"][0]
    assert item["preview"] is None and item["sighting_count"] == 2
    assert item["first_sighting_id"] == early["id"]
    assert client.post(f"/trash/photos/{photos[0]}/restore").status_code == 200
    assert life_list(client)["items"][0]["preview"]["id"] == photos[0]


def test_large_fixture_uses_a_bounded_number_of_projected_queries(collections_app):
    client, engine, _ = collections_app
    [photo_id] = seed_photos(engine, count=1)
    with Session(engine) as session:
        taxon_ids = [add_taxon(session, f"Fixture taxon {i}").id for i in range(150)]
        sightings = [
            Sighting(taxon_id=taxon_id, observed_at=datetime(2025, 1, day))
            for taxon_id in taxon_ids
            for day in range(1, 11)
        ]
        session.add_all(sightings)
        session.flush()
        session.add_all(
            SightingPhoto(sighting_id=item.id, photo_id=photo_id) for item in sightings
        )
        session.commit()

    queries = []

    def track_query(_connection, _cursor, statement, _params, _context, _many):
        if statement.startswith("SELECT"):
            queries.append(statement)

    event.listen(engine, "before_cursor_execute", track_query)
    try:
        small = life_list(client, year=2025, page_size=1)
        query_count = len(queries)
        queries.clear()
        large = life_list(client, year=2025, page_size=100)
    finally:
        event.remove(engine, "before_cursor_execute", track_query)
    assert len(queries) == query_count <= 4
    assert len(large["items"]) == 100 and len(small["items"]) == 1
    assert large["summary"]["scope_sightings"] == 1500
    assert all(row["preview"]["id"] == photo_id for row in large["items"])
    assert all(
        "sighting.notes" not in query and "photo.stored_filename" not in query
        for query in queries
    )
