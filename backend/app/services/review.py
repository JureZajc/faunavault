from __future__ import annotations

from datetime import datetime

from sqlalchemy import and_, exists, func, or_, update
from sqlmodel import Session, select

from app.models import ClassificationJob, Photo, utc_now
from app.schemas import ReviewAcceptResponse, ReviewInbox
from app.services.classification_jobs import ACTIVE_JOB_STATUSES


def record_manual_photo_change(
    photo: Photo, now: datetime, *, resolve_review: bool = True
) -> None:
    if resolve_review and photo.status == "needs_review":
        photo.status = "classified"
    photo.reviewed_at = now if photo.status == "classified" else None
    photo.updated_at = now


def review_inbox(
    session: Session, requested_photo_id: int | None, confidence_threshold: float
) -> ReviewInbox:
    eligible = (Photo.deleted_at.is_(None), Photo.status == "needs_review")
    total = session.exec(select(func.count(Photo.id)).where(*eligible)).one()
    requested_unavailable = False
    photo = None
    if requested_photo_id is not None:
        photo = session.exec(
            select(Photo).where(*eligible, Photo.id == requested_photo_id)
        ).first()
        requested_unavailable = photo is None
    if photo is None:
        photo = session.exec(
            select(Photo).where(*eligible).order_by(Photo.created_at, Photo.id).limit(1)
        ).first()
    if photo is None:
        return ReviewInbox(
            total=0,
            photo=None,
            position=None,
            previous_photo_id=None,
            next_photo_id=None,
            requested_photo_unavailable=requested_unavailable,
            low_confidence=False,
        )

    earlier = or_(
        Photo.created_at < photo.created_at,
        and_(Photo.created_at == photo.created_at, Photo.id < photo.id),
    )
    later = or_(
        Photo.created_at > photo.created_at,
        and_(Photo.created_at == photo.created_at, Photo.id > photo.id),
    )
    position = (
        session.exec(select(func.count(Photo.id)).where(*eligible, earlier)).one() + 1
    )
    previous_id = session.exec(
        select(Photo.id)
        .where(*eligible, earlier)
        .order_by(Photo.created_at.desc(), Photo.id.desc())
        .limit(1)
    ).first()
    next_id = session.exec(
        select(Photo.id)
        .where(*eligible, later)
        .order_by(Photo.created_at, Photo.id)
        .limit(1)
    ).first()
    return ReviewInbox(
        total=total,
        photo=photo,
        position=position,
        previous_photo_id=previous_id,
        next_photo_id=next_id,
        requested_photo_unavailable=requested_unavailable,
        low_confidence=photo.confidence is not None
        and photo.confidence < confidence_threshold,
    )


def accept_review(
    session: Session, photo_id: int, expected_updated_at: datetime
) -> ReviewAcceptResponse | None:
    photo = session.get(Photo, photo_id)
    if photo is None:
        return None
    created_at = photo.created_at
    now = utc_now()
    active_job = exists(
        select(ClassificationJob.id).where(
            ClassificationJob.photo_id == Photo.id,
            ClassificationJob.status.in_(ACTIVE_JOB_STATUSES),
        )
    )
    result = session.exec(
        update(Photo)
        .where(
            Photo.id == photo_id,
            Photo.deleted_at.is_(None),
            Photo.status == "needs_review",
            Photo.updated_at == expected_updated_at,
            ~active_job,
        )
        .values(status="classified", reviewed_at=now, updated_at=now)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        session.rollback()
        return None

    eligible = (Photo.deleted_at.is_(None), Photo.status == "needs_review")
    remaining = session.exec(select(func.count(Photo.id)).where(*eligible)).one()
    later = or_(
        Photo.created_at > created_at,
        and_(Photo.created_at == created_at, Photo.id > photo_id),
    )
    next_id = session.exec(
        select(Photo.id)
        .where(*eligible, later)
        .order_by(Photo.created_at, Photo.id)
        .limit(1)
    ).first()
    if next_id is None and remaining:
        next_id = session.exec(
            select(Photo.id)
            .where(*eligible)
            .order_by(Photo.created_at, Photo.id)
            .limit(1)
        ).first()
    session.commit()
    return ReviewAcceptResponse(
        accepted_photo_id=photo_id, remaining=remaining, next_photo_id=next_id
    )
