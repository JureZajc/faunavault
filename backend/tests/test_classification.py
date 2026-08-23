from __future__ import annotations

import base64
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
    classification_image_path,
    classify_photo_image,
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


def test_heic_classification_requires_policy_compliant_jpeg_derivative(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url="sqlite://",
    )
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True)
    original = settings.image_dirs["original"] / "source.heic"
    original.write_bytes(b"authoritative HEIC bytes")
    photo = Photo(
        original_filename="source.HEIC",
        stored_filename="source.heic",
        resized_filename="source_resized.jpeg",
        thumbnail_filename="source_thumb.jpeg",
        media_type="image/heic",
    )

    with pytest.raises(ClassificationServiceError) as missing:
        classification_image_path(photo, settings)
    assert missing.value.code == "image_unavailable"
    assert "repair-derived" in missing.value.message

    photo.resized_filename = "source_resized.heic"
    (settings.image_dirs["resized"] / photo.resized_filename).write_bytes(b"bad")
    with pytest.raises(ClassificationServiceError):
        classification_image_path(photo, settings)

    photo.resized_filename = "source_resized.jpeg"
    derivative = settings.image_dirs["resized"] / photo.resized_filename
    derivative.write_bytes(b"jpeg")
    assert classification_image_path(photo, settings) == derivative

    jpeg = Photo(
        original_filename="legacy.jpg",
        stored_filename="legacy.jpeg",
        resized_filename="missing.jpeg",
        thumbnail_filename="missing-thumb.jpeg",
        media_type="image/jpeg",
    )
    jpeg_original = settings.image_dirs["original"] / jpeg.stored_filename
    jpeg_original.write_bytes(b"jpeg")
    assert classification_image_path(jpeg, settings) == jpeg_original


def test_heic_retry_reuses_one_encoded_jpeg_derivative(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url="sqlite://",
    )
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True)
    derivative = settings.image_dirs["resized"] / "source_resized.jpeg"
    derivative.write_bytes(b"browser-safe-jpeg")
    photo = Photo(
        original_filename="source.heic",
        stored_filename="source.heic",
        resized_filename=derivative.name,
        thumbnail_filename="source_thumb.jpeg",
        media_type="image/heic",
    )
    images: list[str] = []

    class RetryClient:
        def classify_image(self, image_base64, model, _context):
            images.append(image_base64)
            if len(images) == 1:
                derivative.write_bytes(b"changed-after-first-call")
                raise OllamaClassificationError(
                    "Timed out.",
                    "ollama_timeout",
                    category="read_timeout",
                    retryable=True,
                )
            return result(model)

    outcome = classify_photo_image(
        classification_image_path(photo, settings),
        settings,
        RetryClient(),
        primary_model="primary",
        fallback_model=None,
        job_id=1,
        photo_id=1,
        sleeper=lambda _seconds: None,
    )

    encoded_derivative = base64.b64encode(b"browser-safe-jpeg").decode("ascii")
    assert outcome.result.model == "primary"
    assert images == [encoded_derivative, encoded_derivative]


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
        data={"allow_visual_duplicate": "true"},
    )
    assert response.status_code == 200
    return response.json()


def test_malformed_model_output_is_not_accepted_as_metadata():
    with pytest.raises(OllamaClassificationError, match="did not match the schema"):
        validate_classification({"is_animal": "yes"}, "local-model")


def test_classification_request_timeout_is_three_minutes():
    settings = Settings(_env_file=None)

    assert settings.ollama_connect_timeout_seconds == 5.0
    assert settings.ollama_request_timeout_seconds == 180.0
    assert settings.ollama_keep_alive == "15m"


@pytest.mark.parametrize("species_guess", [None, "", "   ", "Unknown"])
def test_missing_species_guess_is_normalized_for_review(species_guess):
    classification = validate_classification(
        {
            "is_animal": True,
            "display_title": "Unknown animal",
            "common_name": "animal",
            "breed_guess": None,
            "species_guess": species_guess,
            "category": "unknown",
            "confidence": 0.5,
            "description": "An animal requiring review.",
            "tags": ["animal"],
            "needs_review": False,
        },
        "qwen3-vl:8b",
    )

    assert classification.species_guess == "unknown"
    assert classification.needs_review is True


def test_default_models_are_qwen_only():
    settings = Settings(_env_file=None)

    assert settings.ai_primary_model == "qwen3-vl:8b"
    assert settings.ai_fallback_model == "qwen3-vl:8b"


def test_matching_fallback_retains_low_confidence_qwen_result():
    calls: list[str] = []
    qwen_result = result("qwen3-vl:8b", confidence=0.4)

    def classify(_image_base64: str, model: str, _context):
        calls.append(model)
        return qwen_result

    outcome = classify_with_fallback(
        "encoded-image",
        0.65,
        "qwen3-vl:8b",
        "qwen3-vl:8b",
        classify,
        job_id=1,
        photo_id=1,
        sleeper=lambda _seconds: None,
    )

    assert outcome.result is qwen_result
    assert outcome.fallback_attempted is False
    assert calls == ["qwen3-vl:8b"]


def test_matching_fallback_retries_transient_qwen_error_without_fake_fallback():
    calls: list[str] = []

    def classify(_image_base64: str, model: str, _context):
        calls.append(model)
        raise OllamaClassificationError(
            "Could not connect to Ollama.",
            "ollama_unavailable",
            category="transport_failure",
            retryable=True,
        )

    with pytest.raises(ClassificationServiceError) as captured:
        classify_with_fallback(
            "encoded-image",
            0.65,
            "qwen3-vl:8b",
            "qwen3-vl:8b",
            classify,
            job_id=1,
            photo_id=1,
            sleeper=lambda _seconds: None,
        )

    assert captured.value.code == "ollama_unavailable"
    assert captured.value.fallback_attempted is False
    assert calls == ["qwen3-vl:8b", "qwen3-vl:8b"]


def test_fallback_behavior_and_provenance():
    calls: list[str] = []

    def classify(_image_base64: str, model: str, _context):
        calls.append(model)
        if model == "primary":
            raise OllamaClassificationError(
                "Could not connect to Ollama.",
                "ollama_unavailable",
                category="transport_failure",
                retryable=True,
            )
        return result(model)

    outcome = classify_with_fallback(
        "encoded-image",
        0.65,
        "primary",
        "fallback",
        classify,
        job_id=1,
        photo_id=1,
        sleeper=lambda _seconds: None,
    )
    assert outcome.result.model == "fallback"
    assert outcome.fallback_attempted is True
    assert calls == ["primary", "primary", "fallback"]

    primary = result("primary", confidence=0.4)

    def failing_fallback(_image_base64: str, model: str, _context):
        if model == "primary":
            return primary
        raise OllamaClassificationError(
            "Model response was malformed.", "invalid_model_response"
        )

    retained = classify_with_fallback(
        "encoded-image",
        0.65,
        "primary",
        "fallback",
        failing_fallback,
        job_id=1,
        photo_id=1,
        sleeper=lambda _seconds: None,
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
        queued = session.get(ClassificationJob, body["jobs"][0]["job"]["id"])
        queued.prompt_version = "animal-photo-v1"
        session.add(queued)
        session.commit()

    assert worker.run_once() is True
    job_id = body["jobs"][0]["job"]["id"]
    completed = client.get(f"/classification-jobs/{job_id}").json()
    assert completed["status"] == "succeeded"
    assert completed["actual_model"] == "primary-model"
    assert completed["prompt_version"] == "animal-photo-v2"
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


def test_exhausted_internal_retries_do_not_block_the_next_job(classification_app):
    client, engine, settings, _ = classification_app
    first = upload(client, "exhausted.jpg")
    second = upload(client, "next.jpg", "blue")
    client.post(
        "/classification-jobs",
        json={"photo_ids": [first["id"], second["id"]]},
    )
    calls: list[tuple[int, str, int]] = []

    class PerPhotoClient:
        def classify_image(self, _image_base64, model, context):
            calls.append((context.photo_id, context.role, context.request_attempt))
            if context.photo_id == first["id"]:
                raise OllamaClassificationError(
                    "Timed out.",
                    "ollama_timeout",
                    category="read_timeout",
                    retryable=True,
                )
            return result(model)

    worker = ManualWorker(
        engine,
        settings,
        ollama_client=PerPhotoClient(),
        sleeper=lambda _seconds: None,
    )
    assert worker.run_once()
    assert worker.run_once()

    with Session(engine) as session:
        jobs = list(
            session.exec(
                select(ClassificationJob).order_by(ClassificationJob.queued_at)
            ).all()
        )
        assert [job.status for job in jobs] == ["failed", "succeeded"]
        assert jobs[0].attempt_count == 1
        assert jobs[1].attempt_count == 1
    assert calls[-1] == (second["id"], "primary", 1)


def test_internal_transport_retry_does_not_increment_durable_attempt(
    classification_app,
):
    client, engine, settings, _ = classification_app
    photo = upload(client, "retry-once.jpg")
    job_id = client.post(f"/photos/{photo['id']}/classify").json()["jobs"][0]["job"][
        "id"
    ]
    calls = []

    class RetryOnceClient:
        def classify_image(self, _image_base64, model, context):
            calls.append((model, context.role, context.request_attempt))
            if len(calls) == 1:
                raise OllamaClassificationError(
                    "Timed out.",
                    "ollama_timeout",
                    category="read_timeout",
                    retryable=True,
                )
            return result(model)

    worker = ManualWorker(
        engine,
        settings,
        ollama_client=RetryOnceClient(),
        sleeper=lambda _seconds: None,
    )
    assert worker.run_once()

    with Session(engine) as session:
        job = session.get(ClassificationJob, job_id)
        assert job.status == "succeeded"
        assert job.attempt_count == 1
        assert job.actual_model == "primary-model"
        assert job.fallback_attempted is False
    assert calls == [
        ("primary-model", "primary", 1),
        ("primary-model", "primary", 2),
    ]


def test_exhaustion_and_manual_retry_keep_attempt_count_durable(classification_app):
    client, engine, settings, _ = classification_app
    photo = upload(client, "manual-retry.jpg")
    job_id = client.post(f"/photos/{photo['id']}/classify").json()["jobs"][0]["job"][
        "id"
    ]

    class AlwaysTimeoutClient:
        def classify_image(self, _image_base64, _model, _context):
            raise OllamaClassificationError(
                "Timed out.",
                "ollama_timeout",
                category="read_timeout",
                retryable=True,
            )

    failed_worker = ManualWorker(
        engine,
        settings,
        ollama_client=AlwaysTimeoutClient(),
        sleeper=lambda _seconds: None,
    )
    assert failed_worker.run_once()
    with Session(engine) as session:
        failed = session.get(ClassificationJob, job_id)
        assert failed.status == "failed"
        assert failed.attempt_count == 1

    retried = client.post(f"/classification-jobs/{job_id}/retry")
    assert retried.status_code == 202
    assert retried.json()["attempt_count"] == 2

    calls = 0

    class RetryThenSuccessClient:
        def classify_image(self, _image_base64, model, _context):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OllamaClassificationError(
                    "Connection reset.",
                    "ollama_transient_failure",
                    category="transport_failure",
                    retryable=True,
                )
            return result(model)

    successful_worker = ManualWorker(
        engine,
        settings,
        ollama_client=RetryThenSuccessClient(),
        sleeper=lambda _seconds: None,
    )
    assert successful_worker.run_once()
    with Session(engine) as session:
        succeeded = session.get(ClassificationJob, job_id)
        assert succeeded.status == "succeeded"
        assert succeeded.attempt_count == 2
    assert calls == 2


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
            session,
            first_job_id,
            settings,
            clock=lambda: base + timedelta(minutes=2),
        )
        assert retried.created_at == base.replace(tzinfo=None)
        assert retried.queued_at == (base + timedelta(minutes=2)).replace(tzinfo=None)
        assert retried.attempt_count == 2
        assert retried.requested_model == "primary-model"
        assert retried.fallback_model == "fallback-model"
        assert retried.prompt_version == "animal-photo-v2"

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


def test_photo_change_stops_automatic_retry_before_second_request(
    classification_app,
):
    client, engine, settings, _ = classification_app
    photo = upload(client, "changed-before-retry.jpg")
    job_id = client.post(f"/photos/{photo['id']}/classify").json()["jobs"][0]["job"][
        "id"
    ]
    calls = 0

    class EditingTimeoutClient:
        def classify_image(self, _image_base64, _model, _context):
            nonlocal calls
            calls += 1
            with Session(engine) as session:
                stored = session.get(Photo, photo["id"])
                stored.display_title = "Manual title during timeout"
                stored.updated_at = datetime.now(UTC) + timedelta(seconds=1)
                session.add(stored)
                session.commit()
            raise OllamaClassificationError(
                "Timed out.",
                "ollama_timeout",
                category="read_timeout",
                retryable=True,
            )

    worker = ManualWorker(
        engine,
        settings,
        ollama_client=EditingTimeoutClient(),
        sleeper=lambda _seconds: None,
    )
    assert worker.run_once()

    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        job = session.get(ClassificationJob, job_id)
        assert stored.display_title == "Manual title during timeout"
        assert stored.status == "pending"
        assert job.failure_code == "photo_changed"
    assert calls == 1


def test_trash_stops_automatic_retry_before_second_request(classification_app):
    client, engine, settings, _ = classification_app
    photo = upload(client, "trashed-before-retry.jpg")
    job_id = client.post(f"/photos/{photo['id']}/classify").json()["jobs"][0]["job"][
        "id"
    ]
    calls = 0

    class TrashingTimeoutClient:
        def classify_image(self, _image_base64, _model, _context):
            nonlocal calls
            calls += 1
            with Session(engine) as session:
                move_to_trash(photo["id"], session)
            raise OllamaClassificationError(
                "Connection reset.",
                "ollama_transient_failure",
                category="transport_failure",
                retryable=True,
            )

    worker = ManualWorker(
        engine,
        settings,
        ollama_client=TrashingTimeoutClient(),
        sleeper=lambda _seconds: None,
    )
    assert worker.run_once()

    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        job = session.get(ClassificationJob, job_id)
        assert stored.deleted_at is not None
        assert stored.status == "pending"
        assert job.failure_code == "photo_trashed"
    assert calls == 1
