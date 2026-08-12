from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlmodel import Session, select

from app.config import Settings
from app.db import SessionDep
from app.models import ClassificationJob, Photo
from app.schemas import (
    ClassificationEnqueuedItem,
    ClassificationEnqueueRejection,
    ClassificationEnqueueRequest,
    ClassificationEnqueueResponse,
    ClassificationJobCollection,
    ClassificationJobRead,
    ClassificationJobSummary,
    ClassifyPendingRequest,
)
from app.services.classification import ClassificationServiceError
from app.services.classification_jobs import (
    ClassificationWorker,
    enqueue_classification_jobs,
    latest_job_for_photo,
    retry_classification_job,
)
from app.services.photo_lifecycle import active_photo_or_404


def job_read(job: ClassificationJob, session: Session) -> ClassificationJobRead:
    photo = session.get(Photo, job.photo_id)
    latest = latest_job_for_photo(session, job.photo_id)
    retryable = (
        job.status == "failed"
        and photo is not None
        and photo.deleted_at is None
        and latest is not None
        and latest.id == job.id
    )
    return ClassificationJobRead(
        id=job.id or 0,
        photo_id=job.photo_id,
        status=job.status,
        batch_id=job.batch_id,
        batch_kind=job.batch_kind,
        requested_model=job.requested_model,
        fallback_model=job.fallback_model,
        actual_model=job.actual_model,
        fallback_attempted=job.fallback_attempted,
        prompt_version=job.prompt_version,
        attempt_count=job.attempt_count,
        created_at=job.created_at,
        queued_at=job.queued_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        duration_ms=job.duration_ms,
        failure_code=job.failure_code,
        failure_message=job.failure_message,
        classification_status=job.classification_status,
        photo_original_filename=photo.original_filename if photo else None,
        retryable=retryable,
    )


def job_summary(jobs: list[ClassificationJob]) -> ClassificationJobSummary:
    counts = Counter(job.status for job in jobs)
    return ClassificationJobSummary(
        total=len(jobs),
        queued=counts["queued"],
        running=counts["running"],
        succeeded=counts["succeeded"],
        failed=counts["failed"],
    )


def notify_worker(request: Request) -> None:
    worker: ClassificationWorker | None = getattr(
        request.app.state, "classification_worker", None
    )
    if worker is not None:
        worker.notify()


def service_error(error: ClassificationServiceError) -> HTTPException:
    status_code = (
        status.HTTP_404_NOT_FOUND
        if error.code in {"job_not_found", "photo_not_found"}
        else status.HTTP_409_CONFLICT
    )
    return HTTPException(
        status_code=status_code,
        detail={"code": error.code, "message": error.message},
    )


def enqueue_response(
    session: Session,
    settings: Settings,
    photo_ids: list[int],
    intent: str,
    batch_kind: str,
) -> ClassificationEnqueueResponse:
    jobs, rejected = enqueue_classification_jobs(
        session, settings, photo_ids, intent, batch_kind
    )
    models = [item.job for item in jobs]
    return ClassificationEnqueueResponse(
        jobs=[
            ClassificationEnqueuedItem(
                job=job_read(item.job, session), created=item.created
            )
            for item in jobs
        ],
        rejected=[
            ClassificationEnqueueRejection(
                photo_id=item.photo_id, code=item.code, message=item.message
            )
            for item in rejected
        ],
        summary=job_summary(models),
    )


def create_classification_router(settings_provider) -> APIRouter:
    router = APIRouter()

    @router.post(
        "/classification-jobs",
        response_model=ClassificationEnqueueResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def create_jobs(
        payload: ClassificationEnqueueRequest,
        request: Request,
        session: SessionDep,
    ) -> ClassificationEnqueueResponse:
        batch_kind = (
            "reclassification" if payload.intent == "reclassify" else "pending_batch"
        )
        response = enqueue_response(
            session,
            settings_provider(),
            payload.photo_ids,
            payload.intent,
            batch_kind,
        )
        if any(item.created for item in response.jobs):
            notify_worker(request)
        return response

    @router.get("/classification-jobs", response_model=ClassificationJobCollection)
    def list_jobs(
        session: SessionDep,
        photo_id: int | None = None,
        batch_id: str | None = None,
        statuses: list[str] | None = Query(default=None),
        latest_per_photo: bool = False,
    ) -> ClassificationJobCollection:
        statement = select(ClassificationJob)
        if photo_id is not None:
            statement = statement.where(ClassificationJob.photo_id == photo_id)
        if batch_id is not None:
            statement = statement.where(ClassificationJob.batch_id == batch_id)
        if statuses:
            invalid = set(statuses) - {"queued", "running", "succeeded", "failed"}
            if invalid:
                raise HTTPException(status_code=422, detail="Invalid job status")
            statement = statement.where(ClassificationJob.status.in_(statuses))
        jobs = list(
            session.exec(
                statement.order_by(
                    ClassificationJob.created_at.desc(), ClassificationJob.id.desc()
                )
            ).all()
        )
        if latest_per_photo:
            latest: dict[int, ClassificationJob] = {}
            for job in jobs:
                latest.setdefault(job.photo_id, job)
            jobs = list(latest.values())
        return ClassificationJobCollection(
            jobs=[job_read(job, session) for job in jobs], summary=job_summary(jobs)
        )

    @router.get("/classification-jobs/{job_id}", response_model=ClassificationJobRead)
    def get_job(job_id: int, session: SessionDep) -> ClassificationJobRead:
        job = session.get(ClassificationJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Classification job not found")
        return job_read(job, session)

    @router.post(
        "/classification-jobs/{job_id}/retry",
        response_model=ClassificationJobRead,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def retry_job(
        job_id: int, request: Request, session: SessionDep
    ) -> ClassificationJobRead:
        try:
            job = retry_classification_job(session, job_id)
        except ClassificationServiceError as exc:
            raise service_error(exc) from exc
        notify_worker(request)
        return job_read(job, session)

    @router.post(
        "/photos/classify-pending",
        response_model=ClassificationEnqueueResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def classify_pending(
        request: Request,
        session: SessionDep,
        payload: ClassifyPendingRequest | None = None,
    ) -> ClassificationEnqueueResponse:
        payload = payload or ClassifyPendingRequest()
        statement = (
            select(Photo)
            .where(Photo.status == "pending", Photo.deleted_at.is_(None))
            .order_by(Photo.created_at.asc(), Photo.id.asc())
        )
        if payload.photo_ids is not None:
            statement = statement.where(Photo.id.in_(payload.photo_ids))
        if payload.limit is not None:
            statement = statement.limit(payload.limit)
        photo_ids = [
            photo.id for photo in session.exec(statement).all() if photo.id is not None
        ]
        if not photo_ids:
            return ClassificationEnqueueResponse(
                jobs=[], rejected=[], summary=job_summary([])
            )
        response = enqueue_response(
            session,
            settings_provider(),
            photo_ids,
            "classify_pending",
            "pending_batch",
        )
        if any(item.created for item in response.jobs):
            notify_worker(request)
        return response

    @router.post(
        "/photos/{photo_id}/classify",
        response_model=ClassificationEnqueueResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    def classify_one(
        photo_id: int, request: Request, session: SessionDep
    ) -> ClassificationEnqueueResponse:
        photo = active_photo_or_404(photo_id, session)
        intent = "classify_pending" if photo.status == "pending" else "reclassify"
        batch_kind = "single" if intent == "classify_pending" else "reclassification"
        response = enqueue_response(
            session, settings_provider(), [photo_id], intent, batch_kind
        )
        if response.rejected:
            rejection = response.rejected[0]
            raise HTTPException(
                status_code=409,
                detail={"code": rejection.code, "message": rejection.message},
            )
        if any(item.created for item in response.jobs):
            notify_worker(request)
        return response

    return router
