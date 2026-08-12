from __future__ import annotations

from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import event
from sqlmodel import Session, create_engine, select

import app.main as main
from app.config import Settings
from app.models import ClassificationJob, Photo
from app.ollama_client import (
    ClassificationResult,
    OllamaClassificationError,
    validate_classification,
)
from app.services.classification import (
    ClassificationOutcome,
    ClassificationServiceError,
    classify_with_fallback,
)
from app.services.classification_jobs import (
    ClassificationWorker,
    enqueue_classification_jobs,
    recover_interrupted_jobs,
    retry_classification_job,
)
from app.services.photo_lifecycle import move_to_trash


def jpeg_bytes(color: str = "green") -> bytes:
    output = BytesIO()
    Image.new("RGB", (48, 32), color).save(output, format="JPEG")
    return output.getvalue()


def result(model: str, confidence: float = 0.9) -> ClassificationResult:
    return ClassificationResult(
        is_animal=True,
        display_title="Red fox",
        common_name="fox",
        breed_guess=None,
        species_guess="Vulpes vulpes",
        category="mammal",
        confidence=confidence,
        description="A fox.",
        tags=["fox"],
        needs_review=confidence < 0.65,
        model=model,
    )


class ManualWorker(ClassificationWorker):
    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    def notify(self) -> None:
        return None


@pytest.fixture()
def classification_app(tmp_path, monkeypatch):
    database_path = tmp_path / "classification.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
        ai_primary_model="primary-model",
        ai_fallback_model="fallback-model",
    )
    engine = create_engine(
        settings.resolved_database_url,
        connect_args={"check_same_thread": False},
    )

    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "IMAGE_ROOT", settings.image_dir)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)
    monkeypatch.setattr(main, "DATABASE_PATH", database_path)

    def session_override():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    worker = ManualWorker(
        engine,
        settings,
        classifier=lambda _path, runtime_settings: ClassificationOutcome(
            result(runtime_settings.ai_primary_model), False
        ),
    )
    main.app.state.classification_worker = worker
    with TestClient(main.app) as client:
        yield client, engine, settings, worker
    main.app.dependency_overrides.clear()
    del main.app.state.classification_worker


def upload(client: TestClient, filename: str, color: str = "green") -> dict:
    response = client.post(
        "/photos/upload",
        files={"file": (filename, jpeg_bytes(color), "image/jpeg")},
    )
    assert response.status_code == 200
    return response.json()


def test_malformed_model_output_is_not_accepted_as_metadata():
    with pytest.raises(OllamaClassificationError, match="must be a boolean"):
        validate_classification({"is_animal": "yes"}, "local-model")


def test_fallback_behavior_and_provenance():
    calls: list[str] = []

    def classify(_path: Path, model: str):
        calls.append(model)
        if model == "primary":
            raise OllamaClassificationError(
                "Could not connect to Ollama.", "ollama_unavailable"
            )
        return result(model)

    outcome = classify_with_fallback(
        Path("unused.jpg"), 0.65, "primary", "fallback", classify
    )
    assert outcome.result.model == "fallback"
    assert outcome.fallback_attempted is True
    assert calls == ["primary", "fallback"]

    primary = result("primary", confidence=0.4)

    def failing_fallback(_path: Path, model: str):
        if model == "primary":
            return primary
        raise OllamaClassificationError(
            "Model response was malformed.", "invalid_model_response"
        )

    retained = classify_with_fallback(
        Path("unused.jpg"), 0.65, "primary", "fallback", failing_fallback
    )
    assert retained.result is primary
    assert retained.fallback_attempted is True


def test_preserved_urls_enqueue_asynchronous_jobs(classification_app):
    client, engine, _, worker = classification_app
    photo = upload(client, "fox.jpg")

    response = client.post(f"/photos/{photo['id']}/classify")
    assert response.status_code == 202
    body = response.json()
    assert body["jobs"][0]["job"]["status"] == "queued"
    assert body["jobs"][0]["job"]["queued_at"]
    assert body["jobs"][0]["created"] is True
    with Session(engine) as session:
        assert session.get(Photo, photo["id"]).status == "pending"

    assert worker.run_once() is True
    job_id = body["jobs"][0]["job"]["id"]
    completed = client.get(f"/classification-jobs/{job_id}").json()
    assert completed["status"] == "succeeded"
    assert completed["actual_model"] == "primary-model"
    assert completed["prompt_version"] == "animal-photo-v1"
    assert completed["classification_status"] == "classified"
    assert completed["duration_ms"] >= 0

    second = upload(client, "owl.jpg", "blue")
    batch = client.post("/photos/classify-pending", json={"photo_ids": [second["id"]]})
    assert batch.status_code == 202
    assert batch.json()["jobs"][0]["job"]["batch_kind"] == "pending_batch"


def test_duplicate_retry_and_reclassification_semantics(classification_app):
    client, _, _, worker = classification_app
    photo = upload(client, "fox.jpg")
    first = client.post(f"/photos/{photo['id']}/classify").json()
    duplicate = client.post(f"/photos/{photo['id']}/classify").json()
    assert duplicate["jobs"][0]["created"] is False
    assert duplicate["jobs"][0]["job"]["id"] == first["jobs"][0]["job"]["id"]

    assert worker.run_once()
    reclassification = client.post(f"/photos/{photo['id']}/classify")
    assert reclassification.status_code == 202
    assert reclassification.json()["jobs"][0]["job"]["batch_kind"] == (
        "reclassification"
    )


def test_worker_failure_does_not_block_the_queue(classification_app):
    client, engine, settings, _ = classification_app
    first = upload(client, "first.jpg")
    second = upload(client, "second.jpg", "blue")
    client.post(
        "/classification-jobs",
        json={"photo_ids": [first["id"], second["id"]]},
    )
    calls = 0

    def classify(_path: Path, runtime_settings: Settings):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise ClassificationServiceError(
                "ollama_unavailable", "Could not connect to Ollama."
            )
        return ClassificationOutcome(result(runtime_settings.ai_primary_model), False)

    worker = ManualWorker(engine, settings, classifier=classify)
    assert worker.run_once()
    assert worker.run_once()
    with Session(engine) as session:
        jobs = list(
            session.exec(
                select(ClassificationJob).order_by(ClassificationJob.queued_at)
            ).all()
        )
        assert [job.status for job in jobs] == ["failed", "succeeded"]
        assert jobs[0].failure_code == "ollama_unavailable"


def test_retry_refreshes_queued_at_and_preserves_fifo_order(classification_app):
    client, engine, settings, _ = classification_app
    first = upload(client, "first.jpg")
    second = upload(client, "second.jpg", "blue")
    base = datetime(2026, 8, 12, 8, 0, tzinfo=UTC)
    with Session(engine) as session:
        first_jobs, _ = enqueue_classification_jobs(
            session,
            settings,
            [first["id"]],
            "classify_pending",
            "single",
            clock=lambda: base,
        )
        first_job_id = first_jobs[0].job.id
        first_jobs[0].job.status = "failed"
        first_jobs[0].job.failure_code = "ollama_unavailable"
        first_jobs[0].job.failure_message = "Could not connect to Ollama."
        session.add(first_jobs[0].job)
        session.commit()

        enqueue_classification_jobs(
            session,
            settings,
            [second["id"]],
            "classify_pending",
            "single",
            clock=lambda: base + timedelta(minutes=1),
        )
        retried = retry_classification_job(
            session, first_job_id, clock=lambda: base + timedelta(minutes=2)
        )
        assert retried.created_at == base.replace(tzinfo=None)
        assert retried.queued_at == (base + timedelta(minutes=2)).replace(tzinfo=None)
        assert retried.attempt_count == 2

    processed: list[str] = []

    def classify(path: Path, runtime_settings: Settings):
        processed.append(path.name)
        return ClassificationOutcome(result(runtime_settings.ai_primary_model), False)

    worker = ManualWorker(engine, settings, classifier=classify)
    worker.run_once()
    with Session(engine) as session:
        assert session.get(Photo, second["id"]).status == "classified"
        assert session.get(Photo, first["id"]).status == "pending"


def test_restart_recovery_marks_running_job_failed(classification_app):
    client, engine, _, _ = classification_app
    photo = upload(client, "fox.jpg")
    job_id = client.post(f"/photos/{photo['id']}/classify").json()["jobs"][0]["job"][
        "id"
    ]
    with Session(engine) as session:
        job = session.get(ClassificationJob, job_id)
        job.status = "running"
        job.started_at = datetime.now(UTC) - timedelta(seconds=3)
        session.add(job)
        session.commit()

    assert recover_interrupted_jobs(engine) == 1
    with Session(engine) as session:
        job = session.get(ClassificationJob, job_id)
        assert job.status == "failed"
        assert job.failure_code == "worker_interrupted"
        assert job.duration_ms >= 0


def test_trash_rejects_or_invalidates_classification(classification_app):
    client, engine, settings, _ = classification_app
    queued_photo = upload(client, "queued.jpg")
    queued_job = client.post(f"/photos/{queued_photo['id']}/classify").json()["jobs"][
        0
    ]["job"]
    assert client.delete(f"/photos/{queued_photo['id']}").status_code == 200
    with Session(engine) as session:
        assert session.get(ClassificationJob, queued_job["id"]).failure_code == (
            "photo_trashed"
        )
    rejected = client.post(
        "/classification-jobs",
        json={"photo_ids": [queued_photo["id"]], "intent": "reclassify"},
    )
    assert rejected.json()["rejected"][0]["code"] == "photo_in_trash"

    running_photo = upload(client, "running.jpg", "blue")
    response = client.post(f"/photos/{running_photo['id']}/classify").json()

    def trash_during_classification(_path: Path, runtime_settings: Settings):
        with Session(engine) as session:
            move_to_trash(running_photo["id"], session)
        return ClassificationOutcome(result(runtime_settings.ai_primary_model), False)

    worker = ManualWorker(engine, settings, classifier=trash_during_classification)
    assert worker.run_once()
    with Session(engine) as session:
        photo = session.get(Photo, running_photo["id"])
        job = session.get(ClassificationJob, response["jobs"][0]["job"]["id"])
        assert photo.status == "pending"
        assert job.status == "failed"
        assert job.failure_code == "photo_trashed"


def test_photo_change_prevents_delayed_metadata_write(classification_app):
    client, engine, settings, _ = classification_app
    photo = upload(client, "fox.jpg")
    job_id = client.post(f"/photos/{photo['id']}/classify").json()["jobs"][0]["job"][
        "id"
    ]

    def edit_during_classification(_path: Path, runtime_settings: Settings):
        with Session(engine) as session:
            stored = session.get(Photo, photo["id"])
            stored.display_title = "Manual title"
            stored.updated_at = datetime.now(UTC) + timedelta(seconds=1)
            session.add(stored)
            session.commit()
        return ClassificationOutcome(result(runtime_settings.ai_primary_model), False)

    worker = ManualWorker(engine, settings, classifier=edit_during_classification)
    assert worker.run_once()
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        job = session.get(ClassificationJob, job_id)
        assert stored.display_title == "Manual title"
        assert job.failure_code == "photo_changed"
