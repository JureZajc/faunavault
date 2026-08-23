from __future__ import annotations

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, SQLModel, create_engine

import app.main as main
from app.config import Settings
from app.models import ClassificationJob, Photo


@pytest.fixture()
def bulk_app(tmp_path, monkeypatch):
    database_path = tmp_path / "bulk.db"
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
        yield client, engine, settings
    main.app.dependency_overrides.clear()


def add_photo(
    session: Session,
    index: int,
    *,
    tags: list[str] | None = None,
    category: str | None = None,
    deleted: bool = False,
) -> Photo:
    timestamp = datetime(2026, 8, 23, index, tzinfo=UTC)
    photo = Photo(
        original_filename=f"photo-{index}.jpg",
        stored_filename=f"photo-{index}.jpg",
        resized_filename=f"photo-{index}-resized.jpg",
        thumbnail_filename=f"photo-{index}-thumb.jpg",
        tags=tags or [],
        category=category,
        deleted_at=timestamp if deleted else None,
        created_at=timestamp,
        updated_at=timestamp,
    )
    session.add(photo)
    session.flush()
    return photo


def seed_photos(engine, *items: dict) -> list[int]:
    with Session(engine) as session:
        photos = [
            add_photo(session, index + 1, **item) for index, item in enumerate(items)
        ]
        session.commit()
        return [photo.id for photo in photos if photo.id is not None]


def test_add_tags_is_normalized_ordered_and_atomic_for_missing_ids(bulk_app):
    client, engine, _ = bulk_app
    first_id, second_id = seed_photos(
        engine,
        {"tags": [" field ", "Bird", "field"]},
        {"tags": ["night"]},
    )

    response = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [second_id, first_id],
            "operation": "add_tags",
            "tags": ["summer", " bird ", "summer", "Bird"],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "completed",
        "operation": "add_tags",
        "photo_ids": [second_id, first_id],
        "affected_count": 2,
    }
    with Session(engine) as session:
        assert session.get(Photo, first_id).tags == ["field", "Bird", "summer", "bird"]
        assert session.get(Photo, second_id).tags == [
            "night",
            "summer",
            "bird",
            "Bird",
        ]

    failed = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [first_id, 999999],
            "operation": "add_tags",
            "tags": ["should-not-appear"],
        },
    )
    assert failed.status_code == 404
    assert failed.json()["detail"] == {
        "code": "photos_not_found",
        "message": "One or more selected photos no longer exist.",
        "photo_ids": [999999],
    }
    with Session(engine) as session:
        assert "should-not-appear" not in session.get(Photo, first_id).tags


def test_remove_tags_preserves_unrelated_values_and_ignores_absent_tags(bulk_app):
    client, engine, _ = bulk_app
    (photo_id,) = seed_photos(
        engine,
        {"tags": ["field", "remove", "remove", "Bird", "stay"]},
    )

    response = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [photo_id],
            "operation": "remove_tags",
            "tags": [" remove ", "absent"],
        },
    )

    assert response.status_code == 200
    with Session(engine) as session:
        assert session.get(Photo, photo_id).tags == ["field", "Bird", "stay"]


def test_set_and_explicitly_clear_category(bulk_app):
    client, engine, _ = bulk_app
    first_id, second_id = seed_photos(
        engine,
        {"category": "mammal"},
        {"category": "bird"},
    )

    set_response = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [first_id, second_id],
            "operation": "set_category",
            "category": "  field observation  ",
        },
    )
    assert set_response.status_code == 200
    with Session(engine) as session:
        assert session.get(Photo, first_id).category == "field observation"
        assert session.get(Photo, second_id).category == "field observation"

    blank = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [first_id],
            "operation": "set_category",
            "category": "   ",
        },
    )
    assert blank.status_code == 422
    assert blank.json()["detail"]["code"] == "invalid_category"

    clear_response = client.post(
        "/photos/bulk",
        json={"photo_ids": [first_id, second_id], "operation": "clear_category"},
    )
    assert clear_response.status_code == 200
    with Session(engine) as session:
        assert session.get(Photo, first_id).category is None
        assert session.get(Photo, second_id).category is None


def test_move_to_trash_is_atomic_keeps_files_and_fails_active_jobs(bulk_app):
    client, engine, settings = bulk_app
    first_id, second_id = seed_photos(engine, {}, {})
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True, exist_ok=True)
    with Session(engine) as session:
        for photo_id in (first_id, second_id):
            photo = session.get(Photo, photo_id)
            for image_type, filename in (
                ("original", photo.stored_filename),
                ("resized", photo.resized_filename),
                ("thumbs", photo.thumbnail_filename),
            ):
                (settings.image_dirs[image_type] / filename).write_bytes(b"image")
        first = session.get(Photo, first_id)
        session.add(
            ClassificationJob(
                photo_id=first_id,
                status="running",
                batch_id="bulk-test",
                batch_kind="single",
                requested_model="test",
                prompt_version="v1",
                source_photo_updated_at=first.updated_at,
            )
        )
        session.commit()

    response = client.post(
        "/photos/bulk",
        json={"photo_ids": [first_id, second_id], "operation": "move_to_trash"},
    )

    assert response.status_code == 200
    with Session(engine) as session:
        first = session.get(Photo, first_id)
        second = session.get(Photo, second_id)
        assert first.deleted_at is not None
        assert first.deleted_at == second.deleted_at
        job = session.get(ClassificationJob, 1)
        assert job.status == "failed"
        assert job.failure_code == "photo_trashed"
    assert (
        sum(
            len(list(directory.iterdir())) for directory in settings.image_dirs.values()
        )
        == 6
    )


def test_ineligible_photo_and_commit_failure_leave_every_photo_unchanged(
    bulk_app, monkeypatch
):
    client, engine, _ = bulk_app
    active_id, trash_id = seed_photos(
        engine,
        {"category": "before"},
        {"category": "trash", "deleted": True},
    )

    ineligible = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [active_id, trash_id],
            "operation": "set_category",
            "category": "after",
        },
    )
    assert ineligible.status_code == 409
    assert ineligible.json()["detail"]["photo_ids"] == [trash_id]
    with Session(engine) as session:
        assert session.get(Photo, active_id).category == "before"

    original_commit = Session.commit

    def fail_commit(session, *args, **kwargs):
        if session.dirty:
            raise SQLAlchemyError("simulated bulk commit failure")
        return original_commit(session, *args, **kwargs)

    monkeypatch.setattr(Session, "commit", fail_commit)
    failed = client.post(
        "/photos/bulk",
        json={
            "photo_ids": [active_id],
            "operation": "set_category",
            "category": "after",
        },
    )
    assert failed.status_code == 500
    assert failed.json()["detail"] == {
        "code": "bulk_operation_failed",
        "message": "Could not complete the bulk photo action.",
    }
    with Session(engine) as session:
        assert session.get(Photo, active_id).category == "before"


@pytest.mark.parametrize(
    ("payload", "status_code", "code"),
    [
        ({"photo_ids": [], "operation": "move_to_trash"}, 422, "empty_photo_ids"),
        (
            {"photo_ids": [1, 1], "operation": "move_to_trash"},
            422,
            "duplicate_photo_ids",
        ),
        (
            {"photo_ids": [0], "operation": "move_to_trash"},
            422,
            "invalid_photo_ids",
        ),
        (
            {"photo_ids": list(range(1, 252)), "operation": "move_to_trash"},
            413,
            "too_many_photo_ids",
        ),
        (
            {"photo_ids": [1], "operation": "add_tags", "tags": [" "]},
            422,
            "invalid_tags",
        ),
    ],
)
def test_request_policy_errors_are_structured(bulk_app, payload, status_code, code):
    client, _, _ = bulk_app
    response = client.post("/photos/bulk", json=payload)
    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code


@pytest.mark.parametrize(
    "payload",
    [
        {"photo_ids": [1], "operation": "unsupported"},
        {"photo_ids": [1], "operation": "clear_category", "category": "bird"},
        {"photo_ids": [1], "operation": "add_tags"},
    ],
)
def test_invalid_discriminated_payloads_use_validation_errors(bulk_app, payload):
    client, _, _ = bulk_app
    response = client.post("/photos/bulk", json=payload)
    assert response.status_code == 422
    assert isinstance(response.json()["detail"], list)
