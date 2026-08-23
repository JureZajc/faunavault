from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, SQLModel, select

import app.main as main
from app.config import Settings
from app.database import create_database_engine
from app.models import Collection, CollectionPhoto, Photo
from app.services.collections import add_collection_photos


@pytest.fixture()
def collections_app(tmp_path, monkeypatch):
    database_path = tmp_path / "collections.db"
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
        yield client, engine, settings
    main.app.dependency_overrides.clear()
    engine.dispose()


def seed_photos(engine, *, count: int, trashed: set[int] | None = None) -> list[int]:
    trashed = trashed or set()
    with Session(engine) as session:
        photos = []
        for index in range(1, count + 1):
            stamp = datetime(2026, 8, 23, 8, tzinfo=UTC) + timedelta(minutes=index)
            photo = Photo(
                original_filename=f"photo-{index}.jpg",
                stored_filename=f"photo-{index}.jpg",
                resized_filename=f"photo-{index}-resized.jpg",
                thumbnail_filename=f"photo-{index}-thumb.jpg",
                deleted_at=stamp if index in trashed else None,
                created_at=stamp,
                updated_at=stamp,
            )
            session.add(photo)
            photos.append(photo)
        session.commit()
        return [photo.id for photo in photos if photo.id is not None]


def create(client: TestClient, name: str) -> dict:
    response = client.post("/collections", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_create_normalizes_and_enforces_unicode_casefolded_uniqueness(collections_app):
    client, _, _ = collections_app

    created = create(client, "  Croatia\t\n 2026  ")
    assert created["name"] == "Croatia 2026"
    assert created["active_photo_count"] == 0

    duplicate = client.post("/collections", json={"name": "croatia  2026"})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "collection_name_conflict"

    compatibility = create(client, "Ångström")
    assert compatibility["name"] == "Ångström"
    equivalent = client.post("/collections", json={"name": "ÅNGSTRÖM"})
    assert equivalent.status_code == 409

    empty = client.post("/collections", json={"name": " \t\n "})
    assert empty.status_code == 422
    assert empty.json()["detail"]["code"] == "collection_name_empty"
    too_long = client.post("/collections", json={"name": "x" * 101})
    assert too_long.status_code == 422
    assert too_long.json()["detail"]["code"] == "collection_name_too_long"


def test_rename_preserves_membership_and_list_is_name_sorted(collections_app):
    client, engine, _ = collections_app
    (photo_id,) = seed_photos(engine, count=1)
    zebra = create(client, "Zebra")
    alpha = create(client, "alpha")
    assert (
        client.post(
            f"/collections/{zebra['id']}/photos", json={"photo_ids": [photo_id]}
        ).status_code
        == 200
    )

    response = client.patch(
        f"/collections/{zebra['id']}", json={"name": "Best wildlife"}
    )
    assert response.status_code == 200
    assert response.json()["active_photo_count"] == 1
    assert [item["id"] for item in client.get("/collections").json()] == [
        alpha["id"],
        zebra["id"],
    ]

    detail = client.get(f"/collections/{zebra['id']}").json()
    assert detail["name"] == "Best wildlife"
    assert [photo["id"] for photo in detail["photos"]["items"]] == [photo_id]


def test_membership_add_is_atomic_idempotent_and_multi_collection(collections_app):
    client, engine, _ = collections_app
    first, second = seed_photos(engine, count=2)
    with Session(engine) as session:
        photo_updated_at = session.get(Photo, first).updated_at
    one = create(client, "One")
    two = create(client, "Two")

    initial = client.post(
        f"/collections/{one['id']}/photos", json={"photo_ids": [second, first]}
    )
    assert initial.json() == {
        "collection_id": one["id"],
        "requested_count": 2,
        "added_count": 2,
        "already_present_count": 0,
    }
    changed_at = next(
        item["updated_at"]
        for item in client.get("/collections").json()
        if item["id"] == one["id"]
    )
    mixed = client.post(
        f"/collections/{one['id']}/photos", json={"photo_ids": [first, second]}
    )
    assert mixed.json()["added_count"] == 0
    assert mixed.json()["already_present_count"] == 2
    unchanged_at = next(
        item["updated_at"]
        for item in client.get("/collections").json()
        if item["id"] == one["id"]
    )
    assert unchanged_at == changed_at
    assert (
        client.post(
            f"/collections/{two['id']}/photos", json={"photo_ids": [first]}
        ).status_code
        == 200
    )

    missing = client.post(
        f"/collections/{one['id']}/photos", json={"photo_ids": [first, 999999]}
    )
    assert missing.status_code == 404
    with Session(engine) as session:
        rows = list(session.exec(select(CollectionPhoto)).all())
        assert len(rows) == 3
        assert session.get(Photo, first).updated_at == photo_updated_at


@pytest.mark.parametrize(
    ("photo_ids", "status_code", "code"),
    [
        ([], 422, "empty_photo_ids"),
        ([0], 422, "invalid_photo_ids"),
        ([1, 1], 422, "duplicate_photo_ids"),
        (list(range(1, 252)), 413, "too_many_photo_ids"),
    ],
)
def test_membership_request_limits(collections_app, photo_ids, status_code, code):
    client, _, _ = collections_app
    collection = create(client, "Limits")
    response = client.post(
        f"/collections/{collection['id']}/photos", json={"photo_ids": photo_ids}
    )
    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code


def test_membership_accepts_exactly_250_photos(collections_app):
    client, engine, _ = collections_app
    photo_ids = seed_photos(engine, count=250)
    collection = create(client, "Maximum")

    response = client.post(
        f"/collections/{collection['id']}/photos", json={"photo_ids": photo_ids}
    )

    assert response.status_code == 200
    assert response.json()["requested_count"] == 250
    assert response.json()["added_count"] == 250


def test_trash_visibility_restore_remove_and_permanent_delete_cascade(collections_app):
    client, engine, settings = collections_app
    active_id, trash_id = seed_photos(engine, count=2, trashed={2})
    collection = create(client, "Lifecycle")

    rejected = client.post(
        f"/collections/{collection['id']}/photos", json={"photo_ids": [trash_id]}
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "photos_not_active"
    client.post(
        f"/collections/{collection['id']}/photos", json={"photo_ids": [active_id]}
    )
    client.delete(f"/photos/{active_id}")
    assert client.get("/collections").json()[0]["active_photo_count"] == 0
    with Session(engine) as session:
        assert session.get(CollectionPhoto, (collection["id"], active_id)) is not None

    client.post(f"/trash/photos/{active_id}/restore")
    assert client.get("/collections").json()[0]["active_photo_count"] == 1

    client.delete(f"/photos/{active_id}")
    with Session(engine) as session:
        photo = session.get(Photo, active_id)
        for role, filename in (
            ("original", photo.stored_filename),
            ("resized", photo.resized_filename),
            ("thumbs", photo.thumbnail_filename),
        ):
            (settings.image_dirs[role] / filename).write_bytes(b"image")
    deleted = client.delete(f"/trash/photos/{active_id}")
    assert deleted.status_code == 200
    with Session(engine) as session:
        assert session.get(Photo, active_id) is None
        assert session.get(CollectionPhoto, (collection["id"], active_id)) is None

    with Session(engine) as session:
        session.add(CollectionPhoto(collection_id=collection["id"], photo_id=trash_id))
        session.commit()
    removed = client.request(
        "DELETE",
        f"/collections/{collection['id']}/photos",
        json={"photo_ids": [trash_id]},
    )
    assert removed.status_code == 200
    assert removed.json()["removed_count"] == 1
    again = client.request(
        "DELETE",
        f"/collections/{collection['id']}/photos",
        json={"photo_ids": [trash_id]},
    )
    assert again.json()["already_absent_count"] == 1


def test_delete_collection_never_deletes_photos_and_duplicate_row_is_impossible(
    collections_app,
):
    client, engine, _ = collections_app
    (photo_id,) = seed_photos(engine, count=1)
    collection = create(client, "Delete safely")
    client.post(
        f"/collections/{collection['id']}/photos", json={"photo_ids": [photo_id]}
    )

    with Session(engine) as session:
        session.add(CollectionPhoto(collection_id=collection["id"], photo_id=photo_id))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()

    response = client.delete(f"/collections/{collection['id']}")
    assert response.json() == {"status": "deleted", "collection_id": collection["id"]}
    with Session(engine) as session:
        assert session.get(Collection, collection["id"]) is None
        assert session.get(Photo, photo_id) is not None
        assert list(session.exec(select(CollectionPhoto)).all()) == []


def test_detail_paginates_active_photos_in_stable_catalog_order(collections_app):
    client, engine, _ = collections_app
    photo_ids = seed_photos(engine, count=4, trashed={2})
    collection = create(client, "Paged")
    active_ids = [photo_ids[0], photo_ids[2], photo_ids[3]]
    response = client.post(
        f"/collections/{collection['id']}/photos", json={"photo_ids": active_ids}
    )
    assert response.status_code == 200

    first = client.get(
        f"/collections/{collection['id']}", params={"page": 1, "page_size": 2}
    ).json()
    second = client.get(
        f"/collections/{collection['id']}", params={"page": 2, "page_size": 2}
    ).json()
    out_of_range = client.get(
        f"/collections/{collection['id']}", params={"page": 8, "page_size": 2}
    ).json()

    assert first["active_photo_count"] == 3
    assert first["photos"]["total_pages"] == 2
    assert [item["id"] for item in first["photos"]["items"]] == [
        photo_ids[3],
        photo_ids[2],
    ]
    assert [item["id"] for item in second["photos"]["items"]] == [photo_ids[0]]
    assert out_of_range["photos"]["items"] == []


def test_rename_conflict_and_structural_payloads_are_atomic(collections_app):
    client, engine, _ = collections_app
    (photo_id,) = seed_photos(engine, count=1)
    first = create(client, "First")
    second = create(client, "Second")
    client.post(f"/collections/{first['id']}/photos", json={"photo_ids": [photo_id]})

    conflict = client.patch(f"/collections/{first['id']}", json={"name": " SECOND "})
    assert conflict.status_code == 409
    malformed = client.post(
        "/collections", json={"name": "Third", "description": "not supported"}
    )
    assert malformed.status_code == 422
    with Session(engine) as session:
        assert session.get(Collection, first["id"]).name == "First"
        assert session.get(Collection, second["id"]).name == "Second"
        assert session.get(CollectionPhoto, (first["id"], photo_id)) is not None


def test_simulated_membership_commit_failure_rolls_back_all_rows(
    collections_app, monkeypatch
):
    client, engine, _ = collections_app
    (photo_id,) = seed_photos(engine, count=1)
    collection = create(client, "Rollback")

    with Session(engine) as session:
        monkeypatch.setattr(
            session,
            "commit",
            lambda: (_ for _ in ()).throw(SQLAlchemyError("simulated failure")),
        )
        with pytest.raises(HTTPException) as exc_info:
            add_collection_photos(collection["id"], [photo_id], session)
        assert exc_info.value.status_code == 500

    with Session(engine) as session:
        assert list(session.exec(select(CollectionPhoto)).all()) == []
        assert session.get(Photo, photo_id) is not None
