from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.models import Photo, utc_now
from app.schemas import (
    BulkAddTagsRequest,
    BulkClearCategoryRequest,
    BulkMoveToTrashRequest,
    BulkPhotoMutationResponse,
    BulkPhotoRequest,
    BulkRemoveTagsRequest,
    BulkSetCategoryRequest,
)
from app.services.classification import normalize_metadata_text, normalize_tags
from app.services.photo_lifecycle import mark_photos_trashed
from app.services.review import record_manual_photo_change

logger = logging.getLogger(__name__)
MAX_BULK_PHOTO_IDS = 250


def _bulk_error(
    status_code: int,
    code: str,
    message: str,
    *,
    photo_ids: list[int] | None = None,
    max_photo_ids: int | None = None,
) -> HTTPException:
    detail: dict[str, object] = {"code": code, "message": message}
    if photo_ids is not None:
        detail["photo_ids"] = photo_ids
    if max_photo_ids is not None:
        detail["max_photo_ids"] = max_photo_ids
    return HTTPException(status_code=status_code, detail=detail)


def _validate_ids(photo_ids: list[int]) -> None:
    if not photo_ids:
        raise _bulk_error(422, "empty_photo_ids", "Select at least one photo.")
    if len(photo_ids) > MAX_BULK_PHOTO_IDS:
        raise _bulk_error(
            413,
            "too_many_photo_ids",
            f"Select no more than {MAX_BULK_PHOTO_IDS} photos at once.",
            max_photo_ids=MAX_BULK_PHOTO_IDS,
        )
    invalid = [photo_id for photo_id in photo_ids if photo_id < 1]
    if invalid:
        raise _bulk_error(
            422,
            "invalid_photo_ids",
            "Photo IDs must be positive integers.",
            photo_ids=invalid,
        )
    if len(set(photo_ids)) != len(photo_ids):
        duplicates: list[int] = []
        seen: set[int] = set()
        for photo_id in photo_ids:
            if photo_id in seen and photo_id not in duplicates:
                duplicates.append(photo_id)
            seen.add(photo_id)
        raise _bulk_error(
            422,
            "duplicate_photo_ids",
            "Photo IDs must not contain duplicates.",
            photo_ids=duplicates,
        )


def _load_active_photos(photo_ids: list[int], session: Session) -> list[Photo]:
    rows = list(session.exec(select(Photo).where(Photo.id.in_(photo_ids))).all())
    by_id = {photo.id: photo for photo in rows}
    missing = [photo_id for photo_id in photo_ids if photo_id not in by_id]
    if missing:
        raise _bulk_error(
            404,
            "photos_not_found",
            "One or more selected photos no longer exist.",
            photo_ids=missing,
        )
    inactive = [
        photo_id for photo_id in photo_ids if by_id[photo_id].deleted_at is not None
    ]
    if inactive:
        raise _bulk_error(
            409,
            "photos_not_active",
            "Bulk actions are available only for active catalog photos.",
            photo_ids=inactive,
        )
    return [by_id[photo_id] for photo_id in photo_ids]


def _normalized_request_tags(tags: list[str]) -> list[str]:
    normalized = normalize_tags(tags)
    if not normalized:
        raise _bulk_error(
            422,
            "invalid_tags",
            "Enter at least one non-empty tag.",
        )
    return normalized


def apply_bulk_photo_action(
    request: BulkPhotoRequest,
    session: Session,
) -> BulkPhotoMutationResponse:
    _validate_ids(request.photo_ids)
    request_tags: list[str] | None = None
    category: str | None = None
    if isinstance(request, (BulkAddTagsRequest, BulkRemoveTagsRequest)):
        request_tags = _normalized_request_tags(request.tags)
    elif isinstance(request, BulkSetCategoryRequest):
        category = normalize_metadata_text(request.category)
        if category is None:
            raise _bulk_error(
                422,
                "invalid_category",
                "Set category requires a non-empty value.",
            )

    try:
        photos = _load_active_photos(request.photo_ids, session)
        now = utc_now()

        if isinstance(request, BulkAddTagsRequest):
            for photo in photos:
                tags = normalize_tags(
                    [*normalize_tags(photo.tags), *(request_tags or [])]
                )
                if tags != photo.tags:
                    photo.tags = tags
                    record_manual_photo_change(photo, now)
                    session.add(photo)
        elif isinstance(request, BulkRemoveTagsRequest):
            removals = set(request_tags or [])
            for photo in photos:
                tags = [
                    tag for tag in normalize_tags(photo.tags) if tag not in removals
                ]
                if tags != photo.tags:
                    photo.tags = tags
                    record_manual_photo_change(photo, now)
                    session.add(photo)
        elif isinstance(request, BulkSetCategoryRequest):
            for photo in photos:
                if photo.category != category:
                    photo.category = category
                    record_manual_photo_change(photo, now)
                    session.add(photo)
        elif isinstance(request, BulkClearCategoryRequest):
            for photo in photos:
                if photo.category is not None:
                    photo.category = None
                    record_manual_photo_change(photo, now)
                    session.add(photo)
        elif isinstance(request, BulkMoveToTrashRequest):
            mark_photos_trashed(photos, session)

        session.commit()
    except HTTPException:
        session.rollback()
        raise
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Bulk photo operation failed")
        raise _bulk_error(
            500,
            "bulk_operation_failed",
            "Could not complete the bulk photo action.",
        ) from exc

    return BulkPhotoMutationResponse(
        operation=request.operation,
        photo_ids=request.photo_ids,
        affected_count=len(request.photo_ids),
    )
