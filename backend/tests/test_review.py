from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, create_engine, select

import app.main as main
from app.config import Settings
from app.models import ClassificationJob, Photo


class IdleWorker:
    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    def notify(self) -> None:
        pass


@pytest.fixture()
def review_app(tmp_path, monkeypatch):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{tmp_path / 'review.db'}",
    )
    engine = create_engine(
        settings.resolved_database_url, connect_args={"check_same_thread": False}
    )
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)

    def session_override():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    main.app.state.classification_worker = IdleWorker()
    with TestClient(main.app) as client:
        yield client, engine
    main.app.dependency_overrides.clear()
    del main.app.state.classification_worker


def add_photo(
    session: Session,
    index: int,
    *,
    status="needs_review",
    deleted=False,
    created_at: datetime | None = None,
) -> Photo:
    timestamp = created_at or datetime(2026, 1, 1, tzinfo=UTC) + timedelta(
        minutes=index
    )
    photo = Photo(
        original_filename=f"review-{index}.jpg",
        stored_filename=f"review-{index}.jpg",
        resized_filename=f"review-{index}-resized.jpg",
        thumbnail_filename=f"review-{index}-thumb.jpg",
        status=status,
        confidence=0.4,
        created_at=timestamp,
        updated_at=timestamp,
        deleted_at=timestamp if deleted else None,
    )
    session.add(photo)
    session.flush()
    return photo


def test_review_queue_filters_orders_and_handles_missing_photo(review_app):
    client, engine = review_app
    with Session(engine) as session:
        timestamp = datetime(2026, 1, 1, tzinfo=UTC)
        first = add_photo(session, 1, created_at=timestamp)
        second = add_photo(session, 2, created_at=timestamp)
        add_photo(session, 3, status="classified")
        add_photo(session, 4, deleted=True)
        session.commit()
        first_id, second_id = first.id, second.id

    first_page = client.get("/review").json()
    assert first_page["total"] == 2
    assert first_page["photo"]["id"] == first_id
    assert first_page["position"] == 1
    assert first_page["next_photo_id"] == second_id
    assert first_page["low_confidence"] is True
    second_page = client.get("/review", params={"photo": second_id}).json()
    assert second_page["position"] == 2
    assert second_page["previous_photo_id"] == first_id
    missing = client.get("/review", params={"photo": 999}).json()
    assert missing["requested_photo_unavailable"] is True
    assert missing["photo"]["id"] == first_id


def test_accept_preserves_job_provenance_and_rejects_stale_or_active(review_app):
    client, engine = review_app
    with Session(engine) as session:
        first = add_photo(session, 1)
        second = add_photo(session, 2)
        session.commit()
        first_id, second_id = first.id, second.id
        job = ClassificationJob(
            photo_id=first_id,
            status="succeeded",
            batch_id="review-test",
            batch_kind="single",
            requested_model="test-model",
            actual_model="test-model",
            prompt_version="v1",
            source_photo_updated_at=first.updated_at,
            classification_status="needs_review",
        )
        session.add(job)
        session.commit()
        job_id = job.id

    photo = client.get("/review").json()["photo"]
    stale = client.post(
        f"/review/photos/{first_id}/accept",
        json={"expected_updated_at": "2020-01-01T00:00:00"},
    )
    assert stale.status_code == 409
    accepted = client.post(
        f"/review/photos/{first_id}/accept",
        json={"expected_updated_at": photo["updated_at"]},
    )
    assert accepted.status_code == 200
    assert accepted.json() == {
        "accepted_photo_id": first_id,
        "remaining": 1,
        "next_photo_id": second_id,
    }
    with Session(engine) as session:
        stored = session.get(Photo, first_id)
        assert stored.status == "classified"
        assert stored.reviewed_at is not None
        assert session.get(ClassificationJob, job_id).actual_model == "test-model"
    assert (
        client.post(
            f"/review/photos/{first_id}/accept",
            json={"expected_updated_at": photo["updated_at"]},
        ).status_code
        == 409
    )

    queued = client.post(f"/photos/{second_id}/classify")
    assert queued.status_code == 202
    second = client.get(f"/photos/{second_id}").json()
    assert (
        client.post(
            f"/review/photos/{second_id}/accept",
            json={"expected_updated_at": second["updated_at"]},
        ).status_code
        == 409
    )
    with Session(engine) as session:
        assert session.get(Photo, second_id).status == "needs_review"
        assert (
            session.exec(
                select(ClassificationJob).where(ClassificationJob.photo_id == second_id)
            )
            .first()
            .status
            == "queued"
        )


def test_manual_and_bulk_edits_resolve_review_only_when_changed(review_app):
    client, engine = review_app
    with Session(engine) as session:
        first = add_photo(session, 1)
        second = add_photo(session, 2)
        session.commit()
        first_id, second_id = first.id, second.id

    before = client.get(f"/photos/{first_id}").json()
    unchanged = client.patch(f"/photos/{first_id}", json={"category": None})
    assert unchanged.status_code == 200
    assert unchanged.json()["status"] == "needs_review"
    assert unchanged.json()["updated_at"] == before["updated_at"]

    changed = client.patch(
        f"/photos/{first_id}",
        params={"expected_updated_at": before["updated_at"]},
        json={"category": "mammal", "status": "needs_review"},
    )
    assert changed.status_code == 200
    assert changed.json()["status"] == "classified"
    assert changed.json()["reviewed_at"] is not None
    assert (
        client.patch(
            f"/photos/{first_id}",
            params={"expected_updated_at": before["updated_at"]},
            json={"tags": ["fox"]},
        ).status_code
        == 409
    )

    bulk = client.post(
        "/photos/bulk",
        json={"photo_ids": [second_id], "operation": "add_tags", "tags": ["wildlife"]},
    )
    assert bulk.status_code == 200
    second = client.get(f"/photos/{second_id}").json()
    assert second["status"] == "classified"
    assert second["reviewed_at"] is not None
    assert client.get("/review").json()["total"] == 0

    flagged = client.patch(f"/photos/{first_id}", json={"status": "needs_review"})
    assert flagged.status_code == 200
    assert flagged.json()["status"] == "needs_review"
    assert flagged.json()["reviewed_at"] is None
    assert client.get("/review").json()["total"] == 1
