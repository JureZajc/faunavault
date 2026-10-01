from __future__ import annotations

import logging
import math

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import case, delete, func
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.event_schemas import (
    EventAddResponse,
    EventDeleteResponse,
    EventDetail,
    EventFields,
    EventPage,
    EventRemoveResponse,
    EventSummary,
    EventUpdate,
)
from app.models import ArchiveEvent, ArchiveEventPhoto, Photo, utc_now
from app.schemas import TimelinePhotoPreview
from app.services.collections import _load_photos, _validate_photo_ids

logger = logging.getLogger(__name__)


def event_or_404(event_id: int, session: Session) -> ArchiveEvent:
    item = session.get(ArchiveEvent, event_id)
    if item is None:
        raise HTTPException(
            404, detail={"code": "event_not_found", "message": "Trip/Event not found."}
        )
    return item


def _commit(session: Session) -> None:
    try:
        session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Trip/Event operation failed")
        raise HTTPException(
            500,
            detail={
                "code": "event_operation_failed",
                "message": "Could not save the Trip/Event operation.",
            },
        ) from exc


def _counts(session: Session, identities: list[int]) -> dict[int, dict[str, int]]:
    if not identities:
        return {}
    active = Photo.deleted_at.is_(None)
    rows = session.exec(
        select(
            ArchiveEventPhoto.event_id,
            func.sum(case((active, 1), else_=0)),
            func.sum(case((Photo.deleted_at.is_not(None), 1), else_=0)),
            func.sum(case((active & Photo.culling_state.is_(None), 1), else_=0)),
            func.sum(case((active & (Photo.culling_state == "pick"), 1), else_=0)),
            func.sum(case((active & (Photo.culling_state == "reject"), 1), else_=0)),
        )
        .join(Photo, Photo.id == ArchiveEventPhoto.photo_id)
        .where(ArchiveEventPhoto.event_id.in_(identities))
        .group_by(ArchiveEventPhoto.event_id)
    ).all()
    keys = (
        "active_photo_count",
        "trash_photo_count",
        "undecided_count",
        "pick_count",
        "reject_count",
    )
    return {row[0]: dict(zip(keys, row[1:], strict=True)) for row in rows}


def _summary(item: ArchiveEvent, count: int = 0, previews=None) -> EventSummary:
    return EventSummary(
        **item.model_dump(exclude={"notes"}),
        active_photo_count=count,
        previews=previews or [],
    )


def list_events(
    session: Session, *, kind: str | None, page: int, page_size: int
) -> EventPage:
    query = select(ArchiveEvent)
    total_query = select(func.count()).select_from(ArchiveEvent)
    if kind is not None:
        query = query.where(ArchiveEvent.kind == kind)
        total_query = total_query.where(ArchiveEvent.kind == kind)
    total = session.exec(total_query).one()
    items = session.exec(
        query.order_by(ArchiveEvent.start_date.desc(), ArchiveEvent.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    identities = [item.id for item in items]
    counts = _counts(session, identities)
    previews: dict[int, list[TimelinePhotoPreview]] = {}
    if identities:
        ranked = (
            select(
                ArchiveEventPhoto.event_id,
                Photo.id,
                Photo.thumbnail_filename,
                Photo.original_filename,
                Photo.display_title,
                func.row_number()
                .over(
                    partition_by=ArchiveEventPhoto.event_id,
                    order_by=(Photo.created_at.desc(), Photo.id.desc()),
                )
                .label("rank"),
            )
            .join(Photo, Photo.id == ArchiveEventPhoto.photo_id)
            .where(
                ArchiveEventPhoto.event_id.in_(identities), Photo.deleted_at.is_(None)
            )
            .subquery()
        )
        for row in session.exec(
            select(*ranked.c)
            .where(ranked.c.rank <= 4)
            .order_by(ranked.c.event_id, ranked.c.rank)
        ).all():
            previews.setdefault(row.event_id, []).append(
                TimelinePhotoPreview(
                    id=row.id,
                    thumbnail_filename=row.thumbnail_filename,
                    original_filename=row.original_filename,
                    display_title=row.display_title,
                )
            )
    return EventPage(
        items=[
            _summary(
                item,
                counts.get(item.id, {}).get("active_photo_count", 0),
                previews.get(item.id),
            )
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size),
    )


def get_event(event_id: int, session: Session) -> EventDetail:
    item = event_or_404(event_id, session)
    return EventDetail(
        **item.model_dump(), **_counts(session, [event_id]).get(event_id, {})
    )


def create_event(request: EventFields, session: Session) -> EventDetail:
    item = ArchiveEvent(**request.model_dump())
    session.add(item)
    _commit(session)
    session.refresh(item)
    return get_event(item.id, session)


def update_event(event_id: int, request: EventUpdate, session: Session) -> EventDetail:
    item = event_or_404(event_id, session)
    try:
        fields = EventFields(
            **{
                **item.model_dump(include=set(EventFields.model_fields)),
                **request.model_dump(exclude_unset=True),
            }
        )
    except ValidationError as exc:
        raise HTTPException(
            422,
            detail={
                "code": "invalid_event_metadata",
                "message": exc.errors()[0]["msg"],
            },
        ) from exc
    if any(getattr(item, name) != value for name, value in fields.model_dump().items()):
        for name, value in fields.model_dump().items():
            setattr(item, name, value)
        item.updated_at = utc_now()
        session.add(item)
        _commit(session)
    return get_event(event_id, session)


def delete_event(event_id: int, session: Session) -> EventDeleteResponse:
    session.delete(event_or_404(event_id, session))
    _commit(session)
    return EventDeleteResponse(event_id=event_id)


def change_membership(
    event_id: int, photo_ids: list[int], session: Session, *, adding: bool
):
    item = event_or_404(event_id, session)
    _validate_photo_ids(photo_ids)
    photos = _load_photos(photo_ids, session)
    inactive = [
        identity for identity in photo_ids if photos[identity].deleted_at is not None
    ]
    if adding and inactive:
        raise HTTPException(
            409,
            detail={
                "code": "photos_not_active",
                "message": "Only active Photos can be added to a Trip/Event.",
                "photo_ids": inactive,
            },
        )
    present = set(
        session.exec(
            select(ArchiveEventPhoto.photo_id).where(
                ArchiveEventPhoto.event_id == event_id,
                ArchiveEventPhoto.photo_id.in_(photo_ids),
            )
        ).all()
    )
    changed = set(photo_ids) - present if adding else present
    if changed:
        if adding:
            session.add_all(
                ArchiveEventPhoto(event_id=event_id, photo_id=identity)
                for identity in sorted(changed)
            )
        else:
            session.exec(
                delete(ArchiveEventPhoto).where(
                    ArchiveEventPhoto.event_id == event_id,
                    ArchiveEventPhoto.photo_id.in_(changed),
                )
            )
        item.updated_at = utc_now()
        session.add(item)
        _commit(session)
    if adding:
        return EventAddResponse(
            event_id=event_id,
            requested_count=len(photo_ids),
            added_count=len(changed),
            already_present_count=len(present),
        )
    return EventRemoveResponse(
        event_id=event_id,
        requested_count=len(photo_ids),
        removed_count=len(changed),
        already_absent_count=len(photo_ids) - len(changed),
    )
