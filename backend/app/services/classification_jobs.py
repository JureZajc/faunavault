from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Engine
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.config import Settings
from app.models import ClassificationJob, Photo, utc_now
from app.ollama_client import CLASSIFICATION_PROMPT_VERSION
from app.services.classification import (
    ClassificationOutcome,
    ClassificationServiceError,
    apply_classification,
    classification_image_path,
    classify_photo_image,
)

logger = logging.getLogger(__name__)
ACTIVE_JOB_STATUSES = ("queued", "running")


def elapsed_milliseconds(started_at: datetime, finished_at: datetime) -> int:
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=UTC)
    if finished_at.tzinfo is None:
        finished_at = finished_at.replace(tzinfo=UTC)
    return max(0, int((finished_at - started_at).total_seconds() * 1000))


@dataclass(frozen=True)
class EnqueuedJob:
    job: ClassificationJob
    created: bool


@dataclass(frozen=True)
class EnqueueRejection:
    photo_id: int
    code: str
    message: str


def active_job_for_photo(session: Session, photo_id: int) -> ClassificationJob | None:
    return session.exec(
        select(ClassificationJob)
        .where(
            ClassificationJob.photo_id == photo_id,
            ClassificationJob.status.in_(ACTIVE_JOB_STATUSES),
        )
        .order_by(ClassificationJob.queued_at.asc(), ClassificationJob.id.asc())
    ).first()


def latest_job_for_photo(session: Session, photo_id: int) -> ClassificationJob | None:
    return session.exec(
        select(ClassificationJob)
        .where(ClassificationJob.photo_id == photo_id)
        .order_by(ClassificationJob.created_at.desc(), ClassificationJob.id.desc())
    ).first()


def enqueue_classification_jobs(
    session: Session,
    settings: Settings,
    photo_ids: list[int],
    intent: str,
    batch_kind: str,
    clock: Callable[[], datetime] = utc_now,
) -> tuple[list[EnqueuedJob], list[EnqueueRejection]]:
    batch_id = uuid4().hex
    enqueued: list[EnqueuedJob] = []
    rejected: list[EnqueueRejection] = []

    for photo_id in dict.fromkeys(photo_ids):
        photo = session.get(Photo, photo_id)
        if photo is None:
            rejected.append(
                EnqueueRejection(photo_id, "photo_not_found", "Photo not found.")
            )
            continue
        if photo.deleted_at is not None:
            rejected.append(
                EnqueueRejection(
                    photo_id,
                    "photo_in_trash",
                    "A photo in Trash cannot be classified.",
                )
            )
            continue

        active = active_job_for_photo(session, photo_id)
        if active is not None:
            enqueued.append(EnqueuedJob(active, False))
            continue

        latest = latest_job_for_photo(session, photo_id)
        if latest is not None and latest.status == "failed":
            rejected.append(
                EnqueueRejection(
                    photo_id,
                    "retry_required",
                    "The latest classification failed. Retry that job explicitly.",
                )
            )
            continue

        if intent == "classify_pending" and photo.status != "pending":
            rejected.append(
                EnqueueRejection(
                    photo_id,
                    "already_classified",
                    "The photo is already classified. Reclassify it explicitly.",
                )
            )
            continue

        now = clock()
        job = ClassificationJob(
            photo_id=photo_id,
            status="queued",
            batch_id=batch_id,
            batch_kind=batch_kind,
            requested_model=settings.ai_primary_model,
            fallback_model=(
                settings.ai_fallback_model
                if settings.ai_fallback_model != settings.ai_primary_model
                else None
            ),
            prompt_version=CLASSIFICATION_PROMPT_VERSION,
            attempt_count=1,
            created_at=now,
            queued_at=now,
            source_photo_updated_at=photo.updated_at,
        )
        try:
            with session.begin_nested():
                session.add(job)
                session.flush()
        except IntegrityError:
            active = active_job_for_photo(session, photo_id)
            if active is None:
                raise
            enqueued.append(EnqueuedJob(active, False))
            continue
        enqueued.append(EnqueuedJob(job, True))

    session.commit()
    for item in enqueued:
        session.refresh(item.job)
    return enqueued, rejected


def retry_classification_job(
    session: Session,
    job_id: int,
    clock: Callable[[], datetime] = utc_now,
) -> ClassificationJob:
    job = session.get(ClassificationJob, job_id)
    if job is None:
        raise ClassificationServiceError(
            "job_not_found", "Classification job not found."
        )

    latest = latest_job_for_photo(session, job.photo_id)
    if latest is None or latest.id != job.id:
        raise ClassificationServiceError(
            "job_superseded", "A newer classification job exists for this photo."
        )
    if job.status in ACTIVE_JOB_STATUSES:
        return job
    if job.status != "failed":
        raise ClassificationServiceError(
            "job_not_retryable", "Only a failed classification job can be retried."
        )

    photo = session.get(Photo, job.photo_id)
    if photo is None:
        raise ClassificationServiceError("photo_not_found", "Photo not found.")
    if photo.deleted_at is not None:
        raise ClassificationServiceError(
            "photo_in_trash", "Restore the photo before retrying classification."
        )

    now = clock()
    job.status = "queued"
    job.attempt_count += 1
    job.queued_at = now
    job.started_at = None
    job.finished_at = None
    job.duration_ms = None
    job.actual_model = None
    job.fallback_attempted = False
    job.failure_code = None
    job.failure_message = None
    job.classification_status = None
    job.source_photo_updated_at = photo.updated_at
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def fail_active_jobs_for_photo(
    session: Session,
    photo_id: int,
    code: str = "photo_trashed",
    message: str = "The photo was moved to Trash during classification.",
    clock: Callable[[], datetime] = utc_now,
) -> None:
    now = clock()
    jobs = session.exec(
        select(ClassificationJob).where(
            ClassificationJob.photo_id == photo_id,
            ClassificationJob.status.in_(ACTIVE_JOB_STATUSES),
        )
    ).all()
    for job in jobs:
        job.status = "failed"
        job.finished_at = now
        job.failure_code = code
        job.failure_message = message
        if job.started_at is not None:
            job.duration_ms = elapsed_milliseconds(job.started_at, now)
        session.add(job)


def recover_interrupted_jobs(
    engine: Engine, clock: Callable[[], datetime] = utc_now
) -> int:
    with Session(engine) as session:
        jobs = list(
            session.exec(
                select(ClassificationJob).where(ClassificationJob.status == "running")
            ).all()
        )
        now = clock()
        for job in jobs:
            job.status = "failed"
            job.finished_at = now
            job.failure_code = "worker_interrupted"
            job.failure_message = (
                "The backend stopped while classification was running. Retry the job."
            )
            if job.started_at is not None:
                job.duration_ms = elapsed_milliseconds(job.started_at, now)
            session.add(job)
        if jobs:
            session.commit()
        return len(jobs)


Classifier = Callable[[Path, Settings], ClassificationOutcome]


class ClassificationWorker:
    def __init__(
        self,
        engine: Engine,
        settings: Settings,
        classifier: Classifier = classify_photo_image,
        clock: Callable[[], datetime] = utc_now,
    ):
        self.engine = engine
        self.settings = settings
        self.classifier = classifier
        self.clock = clock
        self._wake_event: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopping = False

    def notify(self) -> None:
        if self._loop is not None and self._wake_event is not None:
            self._loop.call_soon_threadsafe(self._wake_event.set)

    async def start(self) -> None:
        if self._task is not None:
            return
        self._loop = asyncio.get_running_loop()
        self._wake_event = asyncio.Event()
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="classification-worker")

    async def stop(self) -> None:
        self._stopping = True
        self.notify()
        if self._task is not None:
            await self._task
        self._task = None
        self._loop = None
        self._wake_event = None

    async def _run(self) -> None:
        while not self._stopping:
            if self._wake_event is not None:
                self._wake_event.clear()
            processed = await asyncio.to_thread(self.run_once)
            if processed:
                continue
            if self._wake_event is None:
                return
            try:
                await asyncio.wait_for(self._wake_event.wait(), timeout=1.0)
            except TimeoutError:
                pass

    def _fail_job(
        self,
        session: Session,
        job: ClassificationJob,
        code: str,
        message: str,
        duration_ms: int | None = None,
    ) -> None:
        job.status = "failed"
        job.finished_at = self.clock()
        job.failure_code = code
        job.failure_message = message
        job.duration_ms = duration_ms
        session.add(job)
        session.commit()

    def _claim_next(self) -> tuple[int | None, bool]:
        with Session(self.engine) as session:
            job = session.exec(
                select(ClassificationJob)
                .where(ClassificationJob.status == "queued")
                .order_by(ClassificationJob.queued_at.asc(), ClassificationJob.id.asc())
            ).first()
            if job is None:
                return None, False

            photo = session.get(Photo, job.photo_id)
            if photo is None:
                self._fail_job(session, job, "photo_not_found", "Photo not found.")
                return None, True
            if photo.deleted_at is not None:
                self._fail_job(
                    session,
                    job,
                    "photo_trashed",
                    "The photo was moved to Trash during classification.",
                )
                return None, True
            if photo.updated_at != job.source_photo_updated_at:
                self._fail_job(
                    session,
                    job,
                    "photo_changed",
                    "Photo metadata changed after classification was queued.",
                )
                return None, True

            job.status = "running"
            job.started_at = self.clock()
            job.finished_at = None
            job.failure_code = None
            job.failure_message = None
            session.add(job)
            session.commit()
            return job.id, True

    def run_once(self) -> bool:
        job_id, processed = self._claim_next()
        if job_id is None:
            return processed

        started = time.monotonic()
        try:
            with Session(self.engine) as session:
                job = session.get(ClassificationJob, job_id)
                if job is None or job.status != "running":
                    return True
                photo = session.get(Photo, job.photo_id)
                if photo is None:
                    raise ClassificationServiceError(
                        "photo_not_found", "Photo not found."
                    )
                image_path = classification_image_path(photo, self.settings)
            outcome = self.classifier(image_path, self.settings)
            duration_ms = max(0, int((time.monotonic() - started) * 1000))

            with Session(self.engine) as session:
                job = session.get(ClassificationJob, job_id)
                if job is None or job.status != "running":
                    return True
                photo = session.get(Photo, job.photo_id)
                if photo is None:
                    self._fail_job(
                        session, job, "photo_not_found", "Photo not found.", duration_ms
                    )
                    return True
                if photo.deleted_at is not None:
                    self._fail_job(
                        session,
                        job,
                        "photo_trashed",
                        "The photo was moved to Trash during classification.",
                        duration_ms,
                    )
                    return True
                if photo.updated_at != job.source_photo_updated_at:
                    self._fail_job(
                        session,
                        job,
                        "photo_changed",
                        "Photo metadata changed while classification was running.",
                        duration_ms,
                    )
                    return True

                apply_classification(
                    photo, outcome.result, self.settings.ai_confidence_threshold
                )
                job.status = "succeeded"
                job.finished_at = self.clock()
                job.duration_ms = duration_ms
                job.actual_model = outcome.result.model
                job.fallback_attempted = outcome.fallback_attempted
                job.classification_status = photo.status
                job.failure_code = None
                job.failure_message = None
                session.add(photo)
                session.add(job)
                session.commit()
            return True
        except ClassificationServiceError as exc:
            duration_ms = max(0, int((time.monotonic() - started) * 1000))
            with Session(self.engine) as session:
                job = session.get(ClassificationJob, job_id)
                if job is not None and job.status == "running":
                    job.fallback_attempted = exc.fallback_attempted
                    self._fail_job(session, job, exc.code, exc.message, duration_ms)
            return True
        except Exception:
            logger.exception(
                "Unexpected classification worker failure for job %s", job_id
            )
            duration_ms = max(0, int((time.monotonic() - started) * 1000))
            with Session(self.engine) as session:
                job = session.get(ClassificationJob, job_id)
                if job is not None and job.status == "running":
                    self._fail_job(
                        session,
                        job,
                        "classification_internal_error",
                        "Classification failed unexpectedly.",
                        duration_ms,
                    )
            return True
