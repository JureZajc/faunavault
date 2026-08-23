from __future__ import annotations

import logging
import math
import unicodedata

from fastapi import HTTPException
from sqlalchemy import and_, delete, func
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, select

from app.models import Collection, CollectionPhoto, Photo, utc_now
from app.schemas import (
    CollectionAddPhotosResponse,
    CollectionDeleteResponse,
    CollectionDetailRead,
    CollectionPhotoPage,
    CollectionRemovePhotosResponse,
    CollectionSummaryRead,
)

logger = logging.getLogger(__name__)
MAX_COLLECTION_NAME_LENGTH = 100
MAX_COLLECTION_PHOTO_IDS = 250


def _error(
    status_code: int,
    code: str,
    message: str,
    **details: object,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, **details},
    )


def normalize_collection_name(value: str) -> tuple[str, str]:
    name = " ".join(value.split())
    if not name:
        raise _error(
            422,
            "collection_name_empty",
            "Collection name must not be empty.",
        )
    if len(name) > MAX_COLLECTION_NAME_LENGTH:
        raise _error(
            422,
            "collection_name_too_long",
            f"Collection name must be {MAX_COLLECTION_NAME_LENGTH} characters or fewer.",
            max_length=MAX_COLLECTION_NAME_LENGTH,
        )
    return name, unicodedata.normalize("NFKC", name).casefold()


def _collection_or_404(collection_id: int, session: Session) -> Collection:
    collection = session.get(Collection, collection_id)
    if collection is None:
        raise _error(
            404,
            "collection_not_found",
            "Collection not found.",
            collection_id=collection_id,
        )
    return collection


def _summary(collection: Collection, active_photo_count: int) -> CollectionSummaryRead:
    return CollectionSummaryRead(
        id=collection.id or 0,
        name=collection.name,
        active_photo_count=active_photo_count,
        created_at=collection.created_at,
        updated_at=collection.updated_at,
    )


def _active_count(collection_id: int, session: Session) -> int:
    return session.exec(
        select(func.count(Photo.id))
        .select_from(CollectionPhoto)
        .join(Photo, CollectionPhoto.photo_id == Photo.id)
        .where(
            CollectionPhoto.collection_id == collection_id,
            Photo.deleted_at.is_(None),
        )
    ).one()


def list_collections(session: Session) -> list[CollectionSummaryRead]:
    active_photo = and_(
        CollectionPhoto.photo_id == Photo.id,
        Photo.deleted_at.is_(None),
    )
    rows = session.execute(
        select(Collection, func.count(Photo.id))
        .select_from(Collection)
        .outerjoin(
            CollectionPhoto,
            CollectionPhoto.collection_id == Collection.id,
        )
        .outerjoin(Photo, active_photo)
        .group_by(Collection.id)
        .order_by(Collection.name_key.asc(), Collection.id.asc())
    ).all()
    return [_summary(collection, count) for collection, count in rows]


def create_collection(name_value: str, session: Session) -> CollectionSummaryRead:
    name, name_key = normalize_collection_name(name_value)
    if session.exec(
        select(Collection.id).where(Collection.name_key == name_key)
    ).first():
        raise _error(
            409,
            "collection_name_conflict",
            "A Collection with this name already exists.",
        )
    now = utc_now()
    collection = Collection(
        name=name,
        name_key=name_key,
        created_at=now,
        updated_at=now,
    )
    try:
        session.add(collection)
        session.commit()
        session.refresh(collection)
    except IntegrityError as exc:
        session.rollback()
        raise _error(
            409,
            "collection_name_conflict",
            "A Collection with this name already exists.",
        ) from exc
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Collection creation failed")
        raise _error(
            500,
            "collection_operation_failed",
            "Could not create the Collection.",
        ) from exc
    return _summary(collection, 0)


def rename_collection(
    collection_id: int,
    name_value: str,
    session: Session,
) -> CollectionSummaryRead:
    collection = _collection_or_404(collection_id, session)
    name, name_key = normalize_collection_name(name_value)
    conflict = session.exec(
        select(Collection.id).where(
            Collection.name_key == name_key,
            Collection.id != collection_id,
        )
    ).first()
    if conflict is not None:
        raise _error(
            409,
            "collection_name_conflict",
            "A Collection with this name already exists.",
        )
    if collection.name != name or collection.name_key != name_key:
        collection.name = name
        collection.name_key = name_key
        collection.updated_at = utc_now()
        try:
            session.add(collection)
            session.commit()
            session.refresh(collection)
        except IntegrityError as exc:
            session.rollback()
            raise _error(
                409,
                "collection_name_conflict",
                "A Collection with this name already exists.",
            ) from exc
        except SQLAlchemyError as exc:
            session.rollback()
            logger.exception("Collection rename failed")
            raise _error(
                500,
                "collection_operation_failed",
                "Could not rename the Collection.",
            ) from exc
    return _summary(collection, _active_count(collection_id, session))


def delete_collection(collection_id: int, session: Session) -> CollectionDeleteResponse:
    collection = _collection_or_404(collection_id, session)
    try:
        session.delete(collection)
        session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Collection deletion failed")
        raise _error(
            500,
            "collection_operation_failed",
            "Could not delete the Collection.",
        ) from exc
    return CollectionDeleteResponse(collection_id=collection_id)


def get_collection_detail(
    collection_id: int,
    session: Session,
    *,
    page: int,
    page_size: int,
) -> CollectionDetailRead:
    collection = _collection_or_404(collection_id, session)
    conditions = (
        CollectionPhoto.collection_id == collection_id,
        Photo.deleted_at.is_(None),
    )
    total = session.exec(
        select(func.count(Photo.id))
        .select_from(CollectionPhoto)
        .join(Photo, CollectionPhoto.photo_id == Photo.id)
        .where(*conditions)
    ).one()
    items = list(
        session.exec(
            select(Photo)
            .select_from(CollectionPhoto)
            .join(Photo, CollectionPhoto.photo_id == Photo.id)
            .where(*conditions)
            .order_by(Photo.created_at.desc(), Photo.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )
    summary = _summary(collection, total)
    return CollectionDetailRead(
        **summary.model_dump(),
        photos=CollectionPhotoPage(
            items=items,
            total=total,
            page=page,
            page_size=page_size,
            total_pages=math.ceil(total / page_size) if total else 0,
        ),
    )


def _validate_photo_ids(photo_ids: list[int]) -> None:
    if not photo_ids:
        raise _error(422, "empty_photo_ids", "Select at least one photo.")
    if len(photo_ids) > MAX_COLLECTION_PHOTO_IDS:
        raise _error(
            413,
            "too_many_photo_ids",
            f"Select no more than {MAX_COLLECTION_PHOTO_IDS} photos at once.",
            max_photo_ids=MAX_COLLECTION_PHOTO_IDS,
        )
    invalid = [photo_id for photo_id in photo_ids if photo_id < 1]
    if invalid:
        raise _error(
            422,
            "invalid_photo_ids",
            "Photo IDs must be positive integers.",
            photo_ids=invalid,
        )
    if len(photo_ids) != len(set(photo_ids)):
        duplicates: list[int] = []
        seen: set[int] = set()
        for photo_id in photo_ids:
            if photo_id in seen and photo_id not in duplicates:
                duplicates.append(photo_id)
            seen.add(photo_id)
        raise _error(
            422,
            "duplicate_photo_ids",
            "Photo IDs must not contain duplicates.",
            photo_ids=duplicates,
        )


def _load_photos(photo_ids: list[int], session: Session) -> dict[int, Photo]:
    photos = list(session.exec(select(Photo).where(Photo.id.in_(photo_ids))).all())
    by_id = {photo.id: photo for photo in photos if photo.id is not None}
    missing = [photo_id for photo_id in photo_ids if photo_id not in by_id]
    if missing:
        raise _error(
            404,
            "photos_not_found",
            "One or more selected photos no longer exist.",
            photo_ids=missing,
        )
    return by_id


def add_collection_photos(
    collection_id: int,
    photo_ids: list[int],
    session: Session,
) -> CollectionAddPhotosResponse:
    collection = _collection_or_404(collection_id, session)
    _validate_photo_ids(photo_ids)
    photos = _load_photos(photo_ids, session)
    inactive = [
        photo_id for photo_id in photo_ids if photos[photo_id].deleted_at is not None
    ]
    if inactive:
        raise _error(
            409,
            "photos_not_active",
            "Only active catalog photos can be added to a Collection.",
            photo_ids=inactive,
        )
    present = set(
        session.exec(
            select(CollectionPhoto.photo_id).where(
                CollectionPhoto.collection_id == collection_id,
                CollectionPhoto.photo_id.in_(photo_ids),
            )
        ).all()
    )
    missing_memberships = [
        photo_id for photo_id in photo_ids if photo_id not in present
    ]
    try:
        if missing_memberships:
            session.add_all(
                CollectionPhoto(collection_id=collection_id, photo_id=photo_id)
                for photo_id in missing_memberships
            )
            collection.updated_at = utc_now()
            session.add(collection)
            session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Adding Collection memberships failed")
        raise _error(
            500,
            "collection_membership_failed",
            "Could not add photos to the Collection.",
        ) from exc
    return CollectionAddPhotosResponse(
        collection_id=collection_id,
        requested_count=len(photo_ids),
        added_count=len(missing_memberships),
        already_present_count=len(present),
    )


def remove_collection_photos(
    collection_id: int,
    photo_ids: list[int],
    session: Session,
) -> CollectionRemovePhotosResponse:
    collection = _collection_or_404(collection_id, session)
    _validate_photo_ids(photo_ids)
    _load_photos(photo_ids, session)
    present = set(
        session.exec(
            select(CollectionPhoto.photo_id).where(
                CollectionPhoto.collection_id == collection_id,
                CollectionPhoto.photo_id.in_(photo_ids),
            )
        ).all()
    )
    try:
        if present:
            session.execute(
                delete(CollectionPhoto).where(
                    CollectionPhoto.collection_id == collection_id,
                    CollectionPhoto.photo_id.in_(present),
                )
            )
            collection.updated_at = utc_now()
            session.add(collection)
            session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Removing Collection memberships failed")
        raise _error(
            500,
            "collection_membership_failed",
            "Could not remove photos from the Collection.",
        ) from exc
    return CollectionRemovePhotosResponse(
        collection_id=collection_id,
        requested_count=len(photo_ids),
        removed_count=len(present),
        already_absent_count=len(photo_ids) - len(present),
    )
