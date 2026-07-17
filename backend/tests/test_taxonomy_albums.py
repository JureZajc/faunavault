from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

import app.main as main


@pytest.fixture()
def database(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    main._taxonomy_search_cache.clear()
    return engine


@pytest.fixture()
def client(database):
    def session_override():
        with Session(database) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    with TestClient(main.app) as test_client:
        yield test_client
    main.app.dependency_overrides.clear()


def add_animal_with_photos(session, species, photo_count=1, taxon=None):
    animal = main.Animal(
        identifier=f"FV-{species}-{photo_count}",
        legacy_species_name=species,
        legacy_common_name=species.lower(),
        taxon_id=taxon.id if taxon else None,
    )
    session.add(animal)
    session.flush()
    for index in range(photo_count):
        session.add(
            main.Photo(
                original_filename=f"{species}-{index}.jpg",
                stored_filename=f"{species}-{index}.jpg",
                resized_filename=f"{species}-{index}-resized.jpg",
                thumbnail_filename=f"{species}-{index}-thumb.jpg",
                species_guess=species,
                common_name=species.lower(),
                animal_id=animal.id,
            )
        )
    session.commit()
    return animal


def test_album_aggregation_counts_unlinked_and_paginates(client, database):
    with Session(database) as session:
        add_animal_with_photos(session, "Panthera leo", 2)
        add_animal_with_photos(session, "Panthera leo", 1)
        add_animal_with_photos(session, "Vulpes vulpes", 0)

    response = client.get("/species-albums", params={"page_size": 1})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert len(body["items"]) == 1
    lion = client.get(
        "/species-albums",
        params={"q": "Panthera", "only_with_photos": True},
    ).json()["items"][0]
    assert lion["verified"] is False
    assert lion["animal_count"] == 2
    assert lion["photo_count"] == 3
    assert lion["cover_thumbnail_filename"]

    with_photos = client.get(
        "/species-albums", params={"only_with_photos": True}
    ).json()
    assert with_photos["total"] == 1


def test_taxon_persistence_and_album_assignment(client, database, monkeypatch):
    with Session(database) as session:
        animal = add_animal_with_photos(session, "lion", 1)
        animal_id = animal.id
        album_key = main.legacy_album_key("lion")

    def fake_request(path, params=None):
        assert path == "/species/5219404"
        return {
            "key": 5219404,
            "scientificName": "Panthera leo (Linnaeus, 1758)",
            "canonicalName": "Panthera leo",
            "rank": "SPECIES",
            "kingdom": "Animalia",
            "phylum": "Chordata",
            "class": "Mammalia",
            "order": "Carnivora",
            "family": "Felidae",
            "genus": "Panthera",
            "species": "Panthera leo",
        }

    monkeypatch.setattr(main, "gbif_request", fake_request)
    monkeypatch.setattr(main, "preferred_vernacular", lambda key: "Lion")
    response = client.put(
        f"/species-albums/{album_key}/taxon", json={"gbif_key": 5219404}
    )
    assert response.status_code == 200
    with Session(database) as session:
        stored = session.get(main.Animal, animal_id)
        assert stored.taxonomy_status == "manually_linked"
        assert stored.taxon_id is not None
        assert len(session.exec(main.select(main.Taxon)).all()) == 1


def test_reconcile_accepts_only_confident_exact_match(client, database, monkeypatch):
    with Session(database) as session:
        add_animal_with_photos(session, "Panthera leo", 1)
        add_animal_with_photos(session, "Shark", 1)

    def fake_request(path, params=None):
        if path == "/species/match" and params["name"] == "Panthera leo":
            return {
                "matchType": "EXACT",
                "confidence": 100,
                "usageKey": 1,
                "rank": "SPECIES",
                "kingdom": "Animalia",
            }
        if path == "/species/match":
            return {
                "matchType": "NONE",
                "confidence": 100,
                "note": "Multiple equal matches",
            }
        if path == "/species/1":
            return {
                "key": 1,
                "scientificName": "Panthera leo",
                "canonicalName": "Panthera leo",
                "rank": "SPECIES",
                "kingdom": "Animalia",
                "species": "Panthera leo",
            }
        raise AssertionError(path)

    monkeypatch.setattr(main, "gbif_request", fake_request)
    monkeypatch.setattr(main, "preferred_vernacular", lambda key: "Lion")
    result = client.post("/taxonomy/reconcile", json={"limit": 50}).json()
    assert result["linked"] == 1
    assert result["unmatched"] == 1
    with Session(database) as session:
        statuses = {
            animal.legacy_species_name: animal.taxonomy_status
            for animal in session.exec(main.select(main.Animal)).all()
        }
    assert statuses == {"Panthera leo": "auto_linked", "Shark": "unmatched"}


def test_taxonomy_search_maps_results_and_degrades_to_local(
    client, database, monkeypatch
):
    with Session(database) as session:
        session.add(
            main.Taxon(
                external_taxon_id="9",
                scientific_name="Vulpes vulpes",
                canonical_name="Vulpes vulpes",
                common_name="Red fox",
                taxonomic_rank="SPECIES",
                kingdom="Animalia",
            )
        )
        session.commit()

    monkeypatch.setattr(
        main,
        "gbif_request",
        lambda path, params=None: (_ for _ in ()).throw(
            main.HTTPException(status_code=503, detail="offline")
        ),
    )
    response = client.get("/taxonomy/search", params={"q": "Vulpes"})
    assert response.status_code == 200
    assert response.json()["external_available"] is False
    assert response.json()["results"][0]["cached"] is True

    response = client.get("/taxonomy/search", params={"q": "unknown"})
    assert response.status_code == 503


def test_migration_preserves_legacy_names_and_is_idempotent(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'migration.db'}")
    monkeypatch.setattr(main, "engine", engine)
    SQLModel.metadata.create_all(engine)
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        session.add(
            main.Photo(
                original_filename="legacy.jpg",
                stored_filename="legacy.jpg",
                resized_filename="legacy-r.jpg",
                thumbnail_filename="legacy-t.jpg",
                common_name="lion",
                species_guess="Panthera leo",
                created_at=now,
                updated_at=now,
            )
        )
        session.commit()
    main.migrate_animals_and_taxonomy()
    main.migrate_animals_and_taxonomy()
    with Session(engine) as session:
        photo = session.exec(main.select(main.Photo)).one()
        animals = session.exec(main.select(main.Animal)).all()
        assert photo.species_guess == "Panthera leo"
        assert len(animals) == 1
        assert animals[0].legacy_species_name == "Panthera leo"
        assert photo.animal_id == animals[0].id
