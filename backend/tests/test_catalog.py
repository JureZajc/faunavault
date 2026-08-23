from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, SQLModel, create_engine

import app.main as main
from app.config import Settings
from app.models import Animal, Photo, Taxon


@pytest.fixture()
def catalog_app(tmp_path, monkeypatch):
    database_path = tmp_path / "catalog.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
    )
    engine = create_engine(
        settings.resolved_database_url,
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "DATABASE_PATH", database_path)
    monkeypatch.setattr(main, "IMAGE_ROOT", settings.image_dir)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)

    def session_override():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    with TestClient(main.app) as client:
        yield client, engine
    main.app.dependency_overrides.clear()


def add_taxon(session: Session, name: str, common_name: str | None = None) -> Taxon:
    taxon = Taxon(
        provider="gbif",
        external_taxon_id=f"key-{name}",
        scientific_name=name,
        canonical_name=name,
        common_name=common_name,
        taxonomic_rank="SPECIES",
        kingdom="Animalia",
        family="Testidae",
        genus=name.split()[0],
        species=name,
    )
    session.add(taxon)
    session.flush()
    return taxon


def add_photo(
    session: Session,
    index: int,
    *,
    created_at: datetime | None = None,
    status: str = "pending",
    category: str | None = None,
    taxon: Taxon | None = None,
    deleted_at: datetime | None = None,
    **metadata,
) -> Photo:
    animal = Animal(
        identifier=f"FV-CATALOG-{index}",
        display_name=metadata.pop("animal_name", None),
        legacy_common_name=metadata.pop("legacy_common_name", None),
        legacy_species_name=metadata.pop("legacy_species_name", None),
        taxon_id=taxon.id if taxon else None,
    )
    session.add(animal)
    session.flush()
    timestamp = created_at or datetime(2026, 1, 1, tzinfo=UTC) + timedelta(
        minutes=index
    )
    photo = Photo(
        original_filename=metadata.pop("original_filename", f"photo-{index}.jpg"),
        stored_filename=f"photo-{index}.jpg",
        resized_filename=f"photo-{index}-resized.jpg",
        thumbnail_filename=f"photo-{index}-thumb.jpg",
        animal_id=animal.id,
        status=status,
        category=category,
        created_at=timestamp,
        updated_at=timestamp,
        deleted_at=deleted_at,
        **metadata,
    )
    session.add(photo)
    session.flush()
    return photo


def test_catalog_empty_validation_and_legacy_contract(catalog_app):
    client, _ = catalog_app
    assert client.get("/catalog/timeline").json() == {
        "years": [],
        "unknown_capture_count": 0,
    }
    body = client.get("/catalog/photos").json()
    assert body == {
        "items": [],
        "page": 1,
        "page_size": 48,
        "total": 0,
        "total_pages": 0,
        "facets": {
            "active_total": 0,
            "status_counts": {
                "pending": 0,
                "classified": 0,
                "needs_review": 0,
            },
            "categories": [],
            "uncategorized_count": 0,
        },
    }
    assert client.get("/photos").json() == []
    for params in (
        {"page": 0},
        {"page_size": 101},
        {"status": "unknown"},
        {"sort": "updated_at"},
        {"order": "sideways"},
        {"taxon_id": 0},
        {"category": "mammal", "uncategorized": True},
    ):
        assert client.get("/catalog/photos", params=params).status_code == 422


def test_photo_map_points_are_lightweight_active_and_lifecycle_aware(catalog_app):
    client, engine = catalog_app
    deleted_at = datetime(2026, 2, 1, tzinfo=UTC)
    with Session(engine) as session:
        first = add_photo(
            session,
            60,
            latitude=46.12345,
            longitude=14.54321,
            display_title="Woodland visitor",
            common_name="Roe deer",
            species_guess="Capreolus capreolus",
            captured_at=datetime(2024, 5, 24, 18, 42),
        )
        same_location = add_photo(
            session,
            61,
            latitude=46.12345,
            longitude=14.54321,
        )
        add_photo(session, 62)
        trashed = add_photo(
            session,
            63,
            latitude=-33.8688,
            longitude=151.2093,
            deleted_at=deleted_at,
        )
        session.commit()
        first_id = first.id
        same_location_id = same_location.id
        trashed_id = trashed.id

    response = client.get("/catalog/map")
    assert response.status_code == 200
    assert response.json() == [
        {
            "id": first_id,
            "latitude": 46.12345,
            "longitude": 14.54321,
            "thumbnail_filename": "photo-60-thumb.jpg",
            "original_filename": "photo-60.jpg",
            "display_title": "Woodland visitor",
            "common_name": "Roe deer",
            "species_guess": "Capreolus capreolus",
            "captured_at": "2024-05-24T18:42:00",
        },
        {
            "id": same_location_id,
            "latitude": 46.12345,
            "longitude": 14.54321,
            "thumbnail_filename": "photo-61-thumb.jpg",
            "original_filename": "photo-61.jpg",
            "display_title": None,
            "common_name": None,
            "species_guess": None,
            "captured_at": None,
        },
    ]
    assert set(response.json()[0]) == {
        "id",
        "latitude",
        "longitude",
        "thumbnail_filename",
        "original_filename",
        "display_title",
        "common_name",
        "species_guess",
        "captured_at",
    }

    assert client.post(f"/trash/photos/{trashed_id}/restore").status_code == 200
    restored = client.get("/catalog/map").json()
    assert [point["id"] for point in restored] == [
        first_id,
        same_location_id,
        trashed_id,
    ]
    assert restored[-1]["latitude"] == -33.8688
    assert restored[-1]["longitude"] == 151.2093

    assert client.delete(f"/photos/{first_id}").status_code == 200
    after_trash = client.get("/catalog/map").json()
    assert [point["id"] for point in after_trash] == [
        same_location_id,
        trashed_id,
    ]


def test_catalog_paginates_filters_sorts_and_reports_global_facets(catalog_app):
    client, engine = catalog_app
    shared_time = datetime(2026, 2, 1, tzinfo=UTC)
    with Session(engine) as session:
        first = add_photo(
            session,
            1,
            created_at=shared_time,
            status="classified",
            category="mammal",
            display_title="Zebra",
            confidence=0.8,
        )
        second = add_photo(
            session,
            2,
            created_at=shared_time,
            status="needs_review",
            category="mammal",
            display_title="Antelope",
            confidence=None,
        )
        add_photo(session, 3, status="pending", category="bird")
        add_photo(session, 4, status="pending", category="  ")
        add_photo(session, 5, status="pending", deleted_at=shared_time)
        session.commit()
        first_id, second_id = first.id, second.id

    first_page = client.get(
        "/catalog/photos",
        params={"page_size": 2, "sort": "created_at", "order": "desc"},
    ).json()
    second_page = client.get(
        "/catalog/photos",
        params={"page": 2, "page_size": 2},
    ).json()
    beyond = client.get(
        "/catalog/photos",
        params={"page": 3, "page_size": 2},
    ).json()
    assert [item["id"] for item in first_page["items"]] == [second_id, first_id]
    repeated = client.get(
        "/catalog/photos",
        params={"page_size": 2, "sort": "created_at", "order": "desc"},
    ).json()
    assert [item["id"] for item in repeated["items"]] == [second_id, first_id]
    assert [item["id"] for item in second_page["items"]] == [4, 3]
    assert beyond["items"] == []
    assert beyond["total"] == 4
    assert beyond["total_pages"] == 2
    assert first_page["facets"]["active_total"] == 4
    assert first_page["facets"]["status_counts"] == {
        "pending": 2,
        "classified": 1,
        "needs_review": 1,
    }
    assert first_page["facets"]["uncategorized_count"] == 1

    mammals = client.get(
        "/catalog/photos",
        params={"category": "mammal", "status": "classified"},
    ).json()
    assert [item["id"] for item in mammals["items"]] == [first_id]
    uncategorized = client.get("/catalog/photos", params={"uncategorized": True}).json()
    assert [item["id"] for item in uncategorized["items"]] == [4]
    by_name = client.get(
        "/catalog/photos",
        params={"sort": "name", "order": "asc", "category": "mammal"},
    ).json()
    assert [item["display_title"] for item in by_name["items"][:2]] == [
        "Antelope",
        "Zebra",
    ]
    confidence = client.get(
        "/catalog/photos", params={"sort": "confidence", "order": "asc"}
    ).json()
    assert confidence["items"][-1]["confidence"] is None


def test_catalog_capture_sort_filter_nulls_and_stable_ties(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        first = add_photo(session, 40, captured_at=datetime(2024, 5, 24, 10, 0))
        second = add_photo(session, 41, captured_at=datetime(2024, 5, 24, 10, 0))
        third = add_photo(session, 42, captured_at=datetime(2024, 5, 25, 9, 0))
        unknown = add_photo(session, 43)
        session.commit()
        identifiers = first.id, second.id, third.id, unknown.id

    newest = client.get(
        "/catalog/photos", params={"sort": "captured_at", "order": "desc"}
    ).json()
    oldest = client.get(
        "/catalog/photos", params={"sort": "captured_at", "order": "asc"}
    ).json()
    assert [item["id"] for item in newest["items"]] == [
        identifiers[2],
        identifiers[1],
        identifiers[0],
        identifiers[3],
    ]
    assert [item["id"] for item in oldest["items"]] == [
        identifiers[0],
        identifiers[1],
        identifiers[2],
        identifiers[3],
    ]

    one_day = client.get(
        "/catalog/photos",
        params={"taken_from": "2024-05-24", "taken_to": "2024-05-24"},
    ).json()
    assert [item["id"] for item in one_day["items"]] == [
        identifiers[1],
        identifiers[0],
    ]
    through_next = client.get(
        "/catalog/photos", params={"taken_to": "2024-05-25"}
    ).json()
    assert {item["id"] for item in through_next["items"]} == set(identifiers[:3])
    invalid = client.get(
        "/catalog/photos",
        params={"taken_from": "2024-05-26", "taken_to": "2024-05-25"},
    )
    assert invalid.status_code == 422


def test_timeline_groups_counts_previews_and_camera_local_offsets(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        august_photos = [
            add_photo(
                session,
                100 + index,
                captured_at=datetime(2026, 8, 20 + index, 10, 0),
                display_title=f"August {index}",
            )
            for index in range(5)
        ]
        tied_first = add_photo(
            session,
            110,
            captured_at=datetime(2026, 9, 1, 8, 0),
            captured_at_offset_minutes=-600,
        )
        tied_second = add_photo(
            session,
            111,
            captured_at=datetime(2026, 9, 1, 8, 0),
            captured_at_offset_minutes=600,
        )
        august_boundary = add_photo(
            session,
            112,
            captured_at=datetime(2026, 8, 31, 23, 45),
            captured_at_offset_minutes=120,
        )
        older = add_photo(
            session,
            113,
            captured_at=datetime(2025, 12, 15, 12, 0),
        )
        add_photo(session, 114)
        add_photo(
            session,
            115,
            deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        trashed_known = add_photo(
            session,
            116,
            captured_at=datetime(2024, 3, 10, 9, 0),
            deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        session.commit()
        august_ids = [photo.id for photo in august_photos]
        tied_ids = [tied_first.id, tied_second.id]
        august_boundary_id = august_boundary.id
        older_id = older.id
        trashed_known_id = trashed_known.id

    statements: list[str] = []

    def record_select(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", record_select)
    try:
        response = client.get("/catalog/timeline")
    finally:
        event.remove(engine, "before_cursor_execute", record_select)

    assert response.status_code == 200
    assert len(statements) == 3
    body = response.json()
    assert body["unknown_capture_count"] == 1
    assert [year["year"] for year in body["years"]] == [2026, 2025]
    assert body["years"][0]["photo_count"] == 8
    assert [month["month"] for month in body["years"][0]["months"]] == [9, 8]
    september, august = body["years"][0]["months"]
    assert september["photo_count"] == 2
    assert [preview["id"] for preview in september["previews"]] == list(
        reversed(tied_ids)
    )
    assert august["photo_count"] == 6
    assert [preview["id"] for preview in august["previews"]] == [
        august_boundary_id,
        *reversed(august_ids[-3:]),
    ]
    assert set(august["previews"][0]) == {
        "id",
        "thumbnail_filename",
        "original_filename",
        "display_title",
    }
    assert body["years"][1] == {
        "year": 2025,
        "photo_count": 1,
        "months": [
            {
                "month": 12,
                "photo_count": 1,
                "previews": [
                    {
                        "id": older_id,
                        "thumbnail_filename": "photo-113-thumb.jpg",
                        "original_filename": "photo-113.jpg",
                        "display_title": None,
                    }
                ],
            }
        ],
    }

    assert client.post(f"/trash/photos/{trashed_known_id}/restore").status_code == 200
    restored = client.get("/catalog/timeline").json()
    assert [year["year"] for year in restored["years"]] == [2026, 2025, 2024]
    assert restored["years"][-1]["months"][0]["month"] == 3

    assert client.delete(f"/photos/{august_boundary_id}").status_code == 200
    after_trash = client.get("/catalog/timeline").json()
    august_after_trash = after_trash["years"][0]["months"][1]
    assert august_after_trash["photo_count"] == 5
    assert august_boundary_id not in [
        preview["id"] for preview in august_after_trash["previews"]
    ]


def test_catalog_search_taxonomy_filter_and_lifecycle_refresh(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes", "Red fox")
        photo = add_photo(
            session,
            10,
            taxon=fox,
            animal_name="Roxy",
            display_title="Woodland visitor",
            tags=["night-watch", "wildlife"],
            category="mammal",
        )
        add_photo(session, 11, display_title="100% bird", category="bird")
        session.commit()
        photo_id, taxon_id = photo.id, fox.id

    for search in ("ROXY", "vulpes wildlife", "100%"):
        result = client.get("/catalog/photos", params={"search": search}).json()
        assert result["total"] == 1
    filtered = client.get("/catalog/photos", params={"taxon_id": taxon_id}).json()
    assert [item["id"] for item in filtered["items"]] == [photo_id]
    searched_and_filtered = client.get(
        "/catalog/photos",
        params={"search": "vulpes", "taxon_id": taxon_id},
    ).json()
    assert [item["id"] for item in searched_and_filtered["items"]] == [photo_id]

    assert client.delete(f"/photos/{photo_id}").status_code == 200
    assert (
        client.get("/catalog/photos", params={"taxon_id": taxon_id}).json()["total"]
        == 0
    )
    assert client.post(f"/trash/photos/{photo_id}/restore").status_code == 200
    assert (
        client.get("/catalog/photos", params={"taxon_id": taxon_id}).json()["total"]
        == 1
    )

    assert (
        client.patch(
            f"/photos/{photo_id}",
            json={"display_title": "Updated searchable title", "status": "classified"},
        ).status_code
        == 200
    )
    updated = client.get(
        "/catalog/photos", params={"search": "updated", "status": "classified"}
    ).json()
    assert [item["id"] for item in updated["items"]] == [photo_id]


def test_catalog_taxa_are_bounded_counted_and_resolve_selected(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxa = [
            add_taxon(session, f"Species {index}", f"Common {index}")
            for index in range(5)
        ]
        for index, taxon in enumerate(taxa[:4]):
            add_photo(session, 20 + index, taxon=taxon)
        add_photo(
            session,
            30,
            taxon=taxa[0],
            deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        session.commit()
        selected_id = taxa[4].id

    first = client.get(
        "/catalog/taxa",
        params={"page_size": 2, "include_id": selected_id},
    ).json()
    second = client.get("/catalog/taxa", params={"page": 2, "page_size": 2}).json()
    assert len(first["items"]) == 2
    assert len(second["items"]) == 2
    assert first["total"] == 4
    assert first["total_pages"] == 2
    assert first["selected"]["taxon_id"] == selected_id
    assert first["selected"]["count"] == 0
    assert first["items"][0]["count"] == 1
    assert (
        client.get("/catalog/taxa", params={"include_id": 999999}).json()["selected"]
        is None
    )
    assert client.get("/catalog/taxa", params={"page_size": 101}).status_code == 422
