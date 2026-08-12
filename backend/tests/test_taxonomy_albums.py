import base64
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

import app.main as main
from app.album_identity import (
    legacy_album_key,
    normalize_legacy_species_group,
    parse_album_key,
    taxon_album_key,
)
from app.config import Settings
from app.services.albums import assign_album_taxon


@pytest.fixture()
def database(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'test.db'}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
    )
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "DATABASE_PATH", tmp_path / "test.db")
    monkeypatch.setattr(main, "IMAGE_ROOT", settings.image_dir)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)
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


def add_named_animal(
    session,
    identifier,
    species,
    *,
    taxon=None,
    created_at=None,
):
    animal = main.Animal(
        identifier=identifier,
        legacy_species_name=species,
        taxon_id=taxon.id if taxon else None,
        created_at=created_at or datetime(2026, 1, 1, tzinfo=UTC),
    )
    session.add(animal)
    session.flush()
    return animal


def add_photo(session, animal, photo_id, created_at, *, deleted=False):
    photo = main.Photo(
        original_filename=f"photo-{photo_id}.jpg",
        stored_filename=f"photo-{photo_id}.jpg",
        resized_filename=f"photo-{photo_id}-resized.jpg",
        thumbnail_filename=f"photo-{photo_id}-thumb.jpg",
        animal_id=animal.id,
        created_at=created_at,
        updated_at=created_at,
        deleted_at=created_at + timedelta(days=1) if deleted else None,
    )
    session.add(photo)
    session.flush()
    return photo


def add_taxon(session, external_id, canonical_name, common_name=None, **ranks):
    taxon = main.Taxon(
        external_taxon_id=str(external_id),
        scientific_name=canonical_name,
        canonical_name=canonical_name,
        common_name=common_name,
        taxonomic_rank="SPECIES",
        kingdom="Animalia",
        taxonomic_class=ranks.get("taxonomic_class"),
        taxonomic_order=ranks.get("taxonomic_order"),
        family=ranks.get("family"),
        genus=ranks.get("genus"),
        species=ranks.get("species", canonical_name),
    )
    session.add(taxon)
    session.flush()
    return taxon


def test_album_identity_preserves_legacy_normalization_and_strict_keys():
    assert normalize_legacy_species_group("  ČRNA\t  Štorklja ") == "črna štorklja"
    assert normalize_legacy_species_group(None) == "unidentified"
    assert normalize_legacy_species_group("") == "unidentified"
    assert normalize_legacy_species_group("   ") == ""
    assert parse_album_key("legacy:").legacy_group == ""
    assert parse_album_key(legacy_album_key(" ČRNA  Štorklja ")).legacy_group == (
        "črna štorklja"
    )
    uppercase = base64.urlsafe_b64encode(b"Lion").decode().rstrip("=")
    assert parse_album_key(f"legacy:{uppercase}") is None
    assert parse_album_key("legacy:bGlvbg=") is None
    assert parse_album_key("taxon:01") is None
    assert parse_album_key("taxon:1").taxon_id == 1


def test_derived_legacy_group_stays_synchronized_on_orm_writes(database):
    with Session(database) as session:
        animal = add_named_animal(session, "FV-SYNC", "  ŽABA ")
        session.commit()
        animal_id = animal.id
    with Session(database) as session:
        animal = session.get(main.Animal, animal_id)
        assert animal.legacy_species_group == "žaba"
        animal.legacy_species_name = " Črna\t štorklja "
        session.add(animal)
        session.commit()
    with Session(database) as session:
        animal = session.get(main.Animal, animal_id)
        assert animal.legacy_species_group == "črna štorklja"


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


def test_album_group_identity_counts_cover_newest_and_trash(client, database):
    base = datetime(2026, 2, 1, tzinfo=UTC)
    with Session(database) as session:
        first = add_named_animal(
            session, "FV-LION-1", " Panthera   Leo ", created_at=base
        )
        second = add_named_animal(
            session, "FV-LION-2", "panthera leo", created_at=base + timedelta(days=3)
        )
        older = add_photo(session, first, 1, base + timedelta(days=1))
        tied_newer_id = add_photo(session, second, 2, base + timedelta(days=1))
        deleted_newest = add_photo(
            session, first, 3, base + timedelta(days=5), deleted=True
        )
        session.commit()
        older_id = older.id
        tied_id = tied_newer_id.id
        deleted_id = deleted_newest.id

    item = client.get("/species-albums").json()["items"][0]
    assert item["animal_count"] == 2
    assert item["photo_count"] == 2
    assert item["cover_photo_id"] == tied_id
    assert item["newest_at"].startswith("2026-02-04")

    detail = client.get(f"/species-albums/{item['album_key']}").json()
    assert [photo["id"] for photo in detail["photos"]["items"]] == [
        tied_id,
        older_id,
    ]
    assert deleted_id not in [photo["id"] for photo in detail["photos"]["items"]]

    with Session(database) as session:
        session.get(main.Photo, tied_id).deleted_at = base + timedelta(days=6)
        session.commit()
    refreshed = client.get(f"/species-albums/{item['album_key']}").json()
    assert refreshed["photo_count"] == 1
    assert refreshed["cover_photo_id"] == older_id
    assert refreshed["animal_count"] == 2
    with Session(database) as session:
        session.get(main.Photo, older_id).deleted_at = base + timedelta(days=7)
        session.commit()
    assert (
        client.get("/species-albums", params={"only_with_photos": True}).json()["total"]
        == 0
    )
    empty_detail = client.get(f"/species-albums/{item['album_key']}").json()
    assert empty_detail["animal_count"] == 2
    assert empty_detail["photo_count"] == 0
    assert empty_detail["cover_photo_id"] is None
    with Session(database) as session:
        session.get(main.Photo, tied_id).deleted_at = None
        session.commit()
    restored = client.get(f"/species-albums/{item['album_key']}").json()
    assert restored["photo_count"] == 1
    assert restored["cover_photo_id"] == tied_id


def test_album_search_preserves_unicode_and_literal_substrings(client, database):
    with Session(database) as session:
        bird = add_taxon(
            session,
            101,
            "Ciconia nigra",
            "Črna štorklja",
            taxonomic_class="Ptiči",
            family="Ciconiidae",
        )
        add_named_animal(session, "FV-BIRD", "ignored", taxon=bird)
        add_named_animal(session, "FV-FROG", "Žaba 100%_\\test")
        session.commit()

    for query, expected in (
        ("ČRNA ŠTORKLJA", "Črna štorklja"),
        ("NIGRA PTIČI", "Črna štorklja"),
        ("ŽABA", "Žaba 100%_\\test"),
        ("100%_\\", "Žaba 100%_\\test"),
    ):
        body = client.get("/species-albums", params={"q": query}).json()
        assert body["total"] == 1
        assert (
            body["items"][0]["common_name"] or body["items"][0]["scientific_name"]
        ) == expected
    assert client.get("/species-albums", params={"q": "ZABA"}).json()["total"] == 0


def test_verified_ids_filters_sorts_and_beyond_page(client, database):
    base = datetime(2026, 3, 1, tzinfo=UTC)
    with Session(database) as session:
        first_taxon = add_taxon(
            session,
            201,
            "Duplicata species",
            "Same name",
            taxonomic_class="Mammalia",
            taxonomic_order="Carnivora",
            family="Exampleidae",
            genus="Duplicata",
        )
        second_taxon = add_taxon(
            session,
            202,
            "Duplicata species",
            "Same name",
            taxonomic_class="Mammalia",
            taxonomic_order="Carnivora",
            family="Exampleidae",
            genus="Duplicata",
        )
        first = add_named_animal(session, "FV-TAXON-1", "legacy", taxon=first_taxon)
        second = add_named_animal(session, "FV-TAXON-2", "legacy", taxon=second_taxon)
        add_named_animal(session, "FV-TAXON-3", "legacy", taxon=first_taxon)
        add_photo(session, first, 10, base)
        add_photo(session, second, 11, base + timedelta(days=1))
        session.commit()
        ids = [first_taxon.id, second_taxon.id]

    body = client.get(
        "/species-albums",
        params={
            "class": "Mammalia",
            "order": "Carnivora",
            "family": "Exampleidae",
            "genus": "Duplicata",
            "species": "Duplicata species",
            "sort": "animal_count",
        },
    ).json()
    assert body["total"] == 2
    assert [item["album_key"] for item in body["items"]] == [
        taxon_album_key(ids[0]),
        taxon_album_key(ids[1]),
    ]
    assert [item["animal_count"] for item in body["items"]] == [2, 1]
    beyond = client.get("/species-albums", params={"page": 3, "page_size": 1}).json()
    assert beyond["items"] == []
    assert beyond["total"] == 2
    assert beyond["page"] == 3
    verified_detail = client.get(f"/species-albums/{taxon_album_key(ids[0])}").json()
    assert verified_detail["verified"] is True
    assert verified_detail["taxonomy"]["external_taxon_id"] == 201
    assert client.get("/species-albums", params={"page": 0}).status_code == 422
    assert client.get("/species-albums", params={"page_size": 101}).status_code == 422


def test_all_album_sorts_and_page_boundaries_are_deterministic(client, database):
    base = datetime(2026, 3, 10, tzinfo=UTC)
    with Session(database) as session:
        alpha_one = add_named_animal(session, "FV-SORT-A1", "Alpha", created_at=base)
        add_named_animal(session, "FV-SORT-A2", "alpha", created_at=base)
        beta = add_named_animal(
            session, "FV-SORT-B", "Beta", created_at=base + timedelta(days=1)
        )
        add_named_animal(session, "FV-SORT-G", "Gamma", created_at=base)
        add_photo(session, alpha_one, 60, base)
        add_photo(session, beta, 61, base + timedelta(days=2))
        add_photo(session, beta, 62, base + timedelta(days=3))
        session.commit()

    expected = {
        "name": ["Alpha", "Beta", "Gamma"],
        "newest": ["Beta", "Alpha", "Gamma"],
        "animal_count": ["Alpha", "Gamma", "Beta"],
        "photo_count": ["Beta", "Alpha", "Gamma"],
    }
    for sort, names in expected.items():
        first = client.get("/species-albums", params={"sort": sort}).json()
        repeated = client.get("/species-albums", params={"sort": sort}).json()
        assert [item["scientific_name"] for item in first["items"]] == names
        assert [item["album_key"] for item in repeated["items"]] == [
            item["album_key"] for item in first["items"]
        ]
    pages = [
        client.get("/species-albums", params={"page": page, "page_size": 1}).json()
        for page in (1, 2, 3, 4)
    ]
    assert [page["items"][0]["scientific_name"] for page in pages[:3]] == [
        "Alpha",
        "Beta",
        "Gamma",
    ]
    assert pages[3]["items"] == []
    assert all(page["total"] == 3 for page in pages)
    with_photos = client.get(
        "/species-albums", params={"only_with_photos": True, "sort": "name"}
    ).json()
    assert [item["scientific_name"] for item in with_photos["items"]] == [
        "Alpha",
        "Beta",
    ]


def test_album_detail_paginates_and_rejects_invalid_keys(client, database):
    with Session(database) as session:
        animals = [
            add_named_animal(session, f"FV-DETAIL-{index}", "Šakal")
            for index in range(3)
        ]
        for index, animal in enumerate(animals):
            add_photo(
                session,
                animal,
                20 + index,
                datetime(2026, 4, index + 1, tzinfo=UTC),
            )
        session.commit()
    key = legacy_album_key("šakal")
    detail = client.get(
        f"/species-albums/{key}",
        params={
            "animal_page": 2,
            "animal_page_size": 1,
            "photo_page": 2,
            "photo_page_size": 1,
        },
    ).json()
    assert detail["animals"]["total"] == 3
    assert detail["animals"]["items"][0]["identifier"] == "FV-DETAIL-1"
    assert detail["photos"]["total"] == 3
    assert detail["photos"]["items"][0]["original_filename"] == "photo-21.jpg"
    for invalid in ("invalid", "taxon:01", "legacy:bGlvbg="):
        assert client.get(f"/species-albums/{invalid}").status_code == 404


def test_taxon_persistence_and_album_assignment(client, database, monkeypatch):
    with Session(database) as session:
        animal = add_animal_with_photos(session, "lion", 1)
        animal_id = animal.id
        album_key = legacy_album_key("lion")

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


def test_album_assignment_updates_exact_normalized_group(client, database, monkeypatch):
    with Session(database) as session:
        first = add_named_animal(session, "FV-LINK-1", "  Panthera   leo ")
        second = add_named_animal(session, "FV-LINK-2", "PANTHERA LEO")
        other = add_named_animal(session, "FV-LINK-3", "Panthera tigris")
        session.commit()
        ids = first.id, second.id, other.id

    monkeypatch.setattr(
        main,
        "gbif_request",
        lambda path, params=None: {
            "key": 303,
            "scientificName": "Panthera leo",
            "canonicalName": "Panthera leo",
            "rank": "SPECIES",
            "kingdom": "Animalia",
            "species": "Panthera leo",
        },
    )
    monkeypatch.setattr(main, "preferred_vernacular", lambda key: "Lion")
    response = client.put(
        f"/species-albums/{legacy_album_key('panthera leo')}/taxon",
        json={"gbif_key": 303},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["updated_animals"] == 2
    assert body["album_key"].startswith("taxon:")
    with Session(database) as session:
        stored = [session.get(main.Animal, animal_id) for animal_id in ids]
        assert stored[0].taxon_id == stored[1].taxon_id
        assert stored[2].taxon_id is None
        assert stored[0].legacy_species_group == "panthera leo"
        assert stored[1].legacy_species_group == "panthera leo"
    assert (
        client.put(
            f"/species-albums/{body['album_key']}/taxon", json={"gbif_key": 303}
        ).status_code
        == 409
    )


def test_unknown_album_assignment_does_not_call_gbif(client, monkeypatch):
    monkeypatch.setattr(
        main,
        "gbif_request",
        lambda *_args, **_kwargs: pytest.fail("GBIF should not be called"),
    )
    response = client.put(
        f"/species-albums/{legacy_album_key('missing')}/taxon",
        json={"gbif_key": 999},
    )
    assert response.status_code == 404


def test_album_assignment_rolls_back_taxon_and_animals(database, monkeypatch):
    with Session(database) as session:
        animal = add_named_animal(session, "FV-ROLLBACK", "Žaba")
        session.commit()
        animal_id = animal.id

    with Session(database) as session:
        identity = parse_album_key(legacy_album_key("Žaba"))

        def persist_taxon(current_session, _key):
            taxon = add_taxon(current_session, 404, "Rollback species")
            return taxon

        def fail_commit():
            raise RuntimeError("simulated commit failure")

        monkeypatch.setattr(session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="simulated commit failure"):
            assign_album_taxon(session, identity, 404, persist_taxon)

    with Session(database) as session:
        assert session.get(main.Animal, animal_id).taxon_id is None
        assert session.exec(main.select(main.Taxon)).all() == []


def test_taxonomy_filter_counts_are_animal_based_and_ignore_trash(client, database):
    with Session(database) as session:
        fox = add_taxon(
            session,
            501,
            "Vulpes vulpes",
            "Rdeča lisica",
            taxonomic_class="Mammalia",
            family="Canidae",
            genus="Vulpes",
        )
        verified = add_named_animal(session, "FV-FILTER-1", "old fox", taxon=fox)
        add_named_animal(session, "FV-FILTER-2", "old fox", taxon=fox)
        add_named_animal(session, "FV-FILTER-3", "  Žaba ")
        add_named_animal(session, "FV-FILTER-4", "žaba")
        add_photo(
            session,
            verified,
            50,
            datetime(2026, 5, 1, tzinfo=UTC),
            deleted=True,
        )
        session.commit()

    filters = client.get("/taxonomy/filters").json()
    assert filters["classes"] == [{"value": "Mammalia", "count": 2}]
    assert filters["families"] == [{"value": "Canidae", "count": 2}]
    assert {item["value"]: item["count"] for item in filters["species"]} == {
        "Vulpes vulpes": 2,
        "  Žaba ": 2,
    }


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


def test_reconcile_limit_is_by_normalized_group(client, database, monkeypatch):
    with Session(database) as session:
        add_named_animal(session, "FV-RECON-1", " Lion ")
        add_named_animal(session, "FV-RECON-2", "LION")
        add_named_animal(session, "FV-RECON-3", "Shark")
        session.commit()
    calls = []

    def fake_request(path, params=None):
        calls.append((path, params["name"]))
        return {"matchType": "NONE", "confidence": 100}

    monkeypatch.setattr(main, "gbif_request", fake_request)
    result = client.post("/taxonomy/reconcile", json={"limit": 1}).json()
    assert result == {
        "processed": 2,
        "linked": 0,
        "ambiguous": 0,
        "unmatched": 2,
        "failed": 0,
    }
    assert calls == [("/species/match", " Lion ")]
    with Session(database) as session:
        statuses = {
            animal.identifier: animal.taxonomy_status
            for animal in session.exec(main.select(main.Animal)).all()
        }
    assert statuses == {
        "FV-RECON-1": "unmatched",
        "FV-RECON-2": "unmatched",
        "FV-RECON-3": "unreviewed",
    }


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
    now = datetime.now(UTC)
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
        assert animals[0].legacy_species_group == "panthera leo"
        assert photo.animal_id == animals[0].id


def test_update_animal_display_name_trims_and_preserves_identity_and_taxonomy(
    client, database
):
    with Session(database) as session:
        taxon = main.Taxon(
            external_taxon_id="5219404",
            scientific_name="Panthera leo",
            canonical_name="Panthera leo",
            common_name="Lion",
            taxonomic_rank="SPECIES",
            kingdom="Animalia",
        )
        session.add(taxon)
        session.flush()
        animal = main.Animal(
            identifier="FV-P000012",
            taxon_id=taxon.id,
            legacy_common_name="lion",
            legacy_species_name="Panthera leo",
            taxonomy_status="manually_linked",
            taxonomy_note="Verified locally",
        )
        session.add(animal)
        session.commit()
        animal_id = animal.id
        taxon_id = taxon.id

    response = client.patch(
        f"/animals/{animal_id}",
        json={"display_name": "  Bella  "},
    )

    assert response.status_code == 200
    updated = response.json()
    assert updated["display_name"] == "Bella"
    assert updated["identifier"] == "FV-P000012"
    assert updated["taxon_id"] == taxon_id
    assert updated["legacy_common_name"] == "lion"
    assert updated["legacy_species_name"] == "Panthera leo"
    assert updated["taxonomy_status"] == "manually_linked"
    assert updated["taxonomy_note"] == "Verified locally"
    assert client.get(f"/animals/{animal_id}").json()["display_name"] == "Bella"


def test_update_animal_display_name_can_be_cleared(client, database):
    with Session(database) as session:
        animal = main.Animal(identifier="FV-P000013", display_name="Bella")
        session.add(animal)
        session.commit()
        animal_id = animal.id

    response = client.patch(
        f"/animals/{animal_id}",
        json={"display_name": "   "},
    )

    assert response.status_code == 200
    assert response.json()["display_name"] is None


def test_update_animal_display_name_rejects_values_over_maximum(client, database):
    with Session(database) as session:
        animal = main.Animal(identifier="FV-P000014")
        session.add(animal)
        session.commit()
        animal_id = animal.id

    response = client.patch(
        f"/animals/{animal_id}",
        json={"display_name": "x" * 101},
    )

    assert response.status_code == 422
    with Session(database) as session:
        assert session.get(main.Animal, animal_id).display_name is None


def test_update_animal_rejects_stable_identifier_changes(client, database):
    with Session(database) as session:
        animal = main.Animal(identifier="FV-P000015", display_name="Bella")
        session.add(animal)
        session.commit()
        animal_id = animal.id

    response = client.patch(
        f"/animals/{animal_id}",
        json={"identifier": "FV-P999999"},
    )

    assert response.status_code == 422
    assert client.get(f"/animals/{animal_id}").json()["identifier"] == "FV-P000015"


def test_update_unknown_animal_returns_404(client):
    response = client.patch(
        "/animals/999999",
        json={"display_name": "Bella"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Animal not found"
