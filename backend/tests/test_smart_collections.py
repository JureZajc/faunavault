from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, select

import app.main as main
from app.config import Settings
from app.database import create_database_engine
from app.models import CollectionPhoto, Photo, SmartCollection
from tests.test_catalog import add_photo


@pytest.fixture()
def smart_app(tmp_path, monkeypatch):
    database_path = tmp_path / "smart.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
    )
    engine = create_database_engine(settings)
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
    engine.dispose()


def create(client, name="Birds 2026", query=None):
    response = client.post(
        "/smart-collections",
        json={"name": name, "query_version": 1, "query": query or {}},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_crud_validation_round_trip_and_manual_separation(smart_app):
    client, engine = smart_app
    manual = client.post("/collections", json={"name": "Birds 2026"})
    assert manual.status_code == 201
    query = {
        "search": "  fox  ",
        "category": "mammal",
        "taken_from": "2026-01-01",
        "sort": "captured_at",
        "order": "desc",
    }
    smart = create(client, query=query)
    assert smart["name"] == "Birds 2026"
    assert smart["query"] == {**smart["query"], "search": "fox", "category": "mammal"}
    assert smart["query_version"] == 1
    assert client.get(f"/smart-collections/{smart['id']}").json() == smart
    assert len(client.get("/smart-collections").json()) == 1
    assert (
        client.post(
            "/smart-collections",
            json={"name": "birds 2026", "query_version": 1, "query": {}},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/smart-collections",
            json={"name": "Invalid", "query_version": 2, "query": {}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={"name": "Invalid", "query_version": 1, "query": {"page": 3}},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"taken_from": 1780000000},
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"category": "bird", "uncategorized": True},
            },
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"taken_from": "2026-02-01", "taken_to": "2026-01-01"},
            },
        ).status_code
        == 422
    )
    assert (
        client.patch(
            f"/smart-collections/{smart['id']}", json={"query": {}}
        ).status_code
        == 422
    )
    updated = client.patch(
        f"/smart-collections/{smart['id']}",
        json={"name": "Foxes", "query_version": 1, "query": {"uncategorized": True}},
    )
    assert updated.status_code == 200
    assert updated.json()["query"]["uncategorized"] is True
    assert client.get("/collections").json()[0]["name"] == "Birds 2026"
    with Session(engine) as session:
        assert session.exec(select(CollectionPhoto)).all() == []
    assert client.delete(f"/smart-collections/{smart['id']}").status_code == 200
    assert client.get(f"/smart-collections/{smart['id']}").status_code == 404
    assert client.get("/collections").json()[0]["name"] == "Birds 2026"


def test_results_match_catalog_and_change_with_photo_lifecycle(smart_app):
    client, engine = smart_app
    with Session(engine) as session:
        first = add_photo(
            session,
            1,
            category="bird",
            original_filename="owl-first.jpg",
            captured_at=datetime(2026, 4, 1),
        )
        second = add_photo(
            session,
            2,
            category="bird",
            original_filename="owl-second.jpg",
            captured_at=datetime(2026, 4, 2),
        )
        add_photo(session, 3, category="mammal", original_filename="fox.jpg")
        session.commit()
        first_id, second_id = first.id, second.id
    query = {
        "search": "owl",
        "category": "bird",
        "taken_from": "2026-01-01",
        "taken_to": "2026-12-31",
        "sort": "captured_at",
        "order": "desc",
    }
    smart = create(client, query=query)
    url = f"/smart-collections/{smart['id']}/photos"
    catalog = client.get("/catalog/photos", params={**query, "page_size": 1}).json()
    saved = client.get(url, params={"page_size": 1}).json()
    assert [p["id"] for p in saved["items"]] == [p["id"] for p in catalog["items"]]
    assert saved["total"] == catalog["total"] == 2
    assert (
        client.get(url, params={"page": 2, "page_size": 1}).json()["items"][0]["id"]
        == first_id
    )
    assert client.get(url, params={"page_size": 101}).status_code == 422

    with Session(engine) as session:
        session.get(Photo, second_id).category = "mammal"
        session.commit()
    assert client.get(url).json()["total"] == 1
    with Session(engine) as session:
        third = add_photo(
            session,
            4,
            category="bird",
            original_filename="owl-new.jpg",
            captured_at=datetime(2026, 4, 3),
        )
        session.commit()
        third_id = third.id
    assert [p["id"] for p in client.get(url).json()["items"]] == [third_id, first_id]
    with Session(engine) as session:
        session.get(Photo, first_id).deleted_at = datetime.now(UTC)
        session.commit()
    assert [p["id"] for p in client.get(url).json()["items"]] == [third_id]
    with Session(engine) as session:
        session.get(Photo, first_id).deleted_at = None
        session.commit()
    assert client.get(url).json()["total"] == 2
    assert client.delete(f"/smart-collections/{smart['id']}").status_code == 200
    with Session(engine) as session:
        assert session.get(Photo, first_id) is not None
        assert session.exec(select(CollectionPhoto)).all() == []


def test_invalid_saved_definition_is_isolated_and_repairable(smart_app):
    client, engine = smart_app
    good = create(client, "Good")
    bad = create(client, "Bad")
    with Session(engine) as session:
        row = session.get(SmartCollection, bad["id"])
        row.query_version = 99
        session.commit()
    listed = client.get("/smart-collections").json()
    assert [item["query_valid"] for item in listed] == [False, True]
    assert client.get(f"/smart-collections/{bad['id']}").json()["query"] is None
    assert client.get(f"/smart-collections/{bad['id']}/photos").status_code == 422
    assert client.get(f"/smart-collections/{good['id']}/photos").status_code == 200
    assert (
        client.patch(
            f"/smart-collections/{bad['id']}", json={"name": "Still bad"}
        ).json()["query_valid"]
        is False
    )
    assert (
        client.patch(
            f"/smart-collections/{bad['id']}", json={"query_version": 1, "query": {}}
        ).json()["query_valid"]
        is True
    )
    with Session(engine) as session:
        row = session.get(SmartCollection, bad["id"])
        row.query_json = '{"unknown": true}'
        session.commit()
    assert client.get(f"/smart-collections/{bad['id']}").json()["query_valid"] is False
