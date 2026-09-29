from __future__ import annotations

import logging

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, select

from app.catalog_query import CatalogSavedQuery
from app.models import SmartCollection, utc_now
from app.schemas import (
    CatalogPhotoPage,
    SmartCollectionDeleteResponse,
    SmartCollectionRead,
    SmartCollectionSummaryRead,
    SmartCollectionUpdateRequest,
)
from app.services.catalog import list_catalog_photos
from app.services.collections import normalize_collection_name

logger = logging.getLogger(__name__)


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _get(collection_id: int, session: Session) -> SmartCollection:
    collection = session.get(SmartCollection, collection_id)
    if collection is None:
        raise _error(404, "smart_collection_not_found", "Smart Collection not found.")
    return collection


def _query(collection: SmartCollection) -> tuple[CatalogSavedQuery | None, str | None]:
    if collection.query_version != 1:
        return None, f"Unsupported saved query version {collection.query_version}."
    try:
        return CatalogSavedQuery.model_validate_json(collection.query_json), None
    except (ValidationError, ValueError):
        return (
            None,
            "Saved criteria are invalid. Replace them from List to repair this Smart Collection.",
        )


def _read(collection: SmartCollection) -> SmartCollectionRead:
    query, error = _query(collection)
    return SmartCollectionRead(
        id=collection.id or 0,
        name=collection.name,
        query_version=collection.query_version,
        query_valid=error is None,
        query_error=error,
        query=query,
        created_at=collection.created_at,
        updated_at=collection.updated_at,
    )


def list_smart_collections(session: Session) -> list[SmartCollectionSummaryRead]:
    collections = session.exec(
        select(SmartCollection).order_by(SmartCollection.name_key, SmartCollection.id)
    ).all()
    return [
        SmartCollectionSummaryRead(**_read(item).model_dump(exclude={"query"}))
        for item in collections
    ]


def get_smart_collection(collection_id: int, session: Session) -> SmartCollectionRead:
    return _read(_get(collection_id, session))


def _check_name(name_key: str, collection_id: int | None, session: Session) -> None:
    statement = select(SmartCollection.id).where(SmartCollection.name_key == name_key)
    if collection_id is not None:
        statement = statement.where(SmartCollection.id != collection_id)
    if session.exec(statement).first() is not None:
        raise _error(
            409,
            "smart_collection_name_conflict",
            "A Smart Collection with this name already exists.",
        )


def _commit(session: Session, operation: str) -> None:
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise _error(
            409,
            "smart_collection_name_conflict",
            "A Smart Collection with this name already exists.",
        ) from exc
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Smart Collection %s failed", operation)
        raise _error(
            500,
            "smart_collection_operation_failed",
            f"Could not {operation} the Smart Collection.",
        ) from exc


def create_smart_collection(
    name_value: str, query: CatalogSavedQuery, session: Session
) -> SmartCollectionRead:
    name, name_key = normalize_collection_name(name_value)
    _check_name(name_key, None, session)
    now = utc_now()
    collection = SmartCollection(
        name=name,
        name_key=name_key,
        query_version=1,
        query_json=query.model_dump_json(exclude_none=True),
        created_at=now,
        updated_at=now,
    )
    session.add(collection)
    _commit(session, "create")
    session.refresh(collection)
    return _read(collection)


def update_smart_collection(
    collection_id: int, request: SmartCollectionUpdateRequest, session: Session
) -> SmartCollectionRead:
    collection = _get(collection_id, session)
    if request.name is None and request.query is None:
        raise _error(
            422, "empty_smart_collection_update", "Provide a name or saved query."
        )
    if (request.query is None) != (request.query_version is None):
        raise _error(
            422,
            "invalid_smart_collection_update",
            "Provide query and query_version together.",
        )
    changed = False
    if request.name is not None:
        name, name_key = normalize_collection_name(request.name)
        _check_name(name_key, collection_id, session)
        if name != collection.name or name_key != collection.name_key:
            collection.name = name
            collection.name_key = name_key
            changed = True
    if request.query is not None:
        serialized = request.query.model_dump_json(exclude_none=True)
        if collection.query_version != 1 or collection.query_json != serialized:
            collection.query_version = 1
            collection.query_json = serialized
            changed = True
    if changed:
        collection.updated_at = utc_now()
        session.add(collection)
        _commit(session, "update")
        session.refresh(collection)
    return _read(collection)


def delete_smart_collection(
    collection_id: int, session: Session
) -> SmartCollectionDeleteResponse:
    session.delete(_get(collection_id, session))
    _commit(session, "delete")
    return SmartCollectionDeleteResponse(smart_collection_id=collection_id)


def list_smart_collection_photos(
    collection_id: int, session: Session, *, page: int, page_size: int
) -> CatalogPhotoPage:
    collection = _get(collection_id, session)
    query, error = _query(collection)
    if query is None:
        raise _error(
            422,
            "invalid_smart_collection_query",
            error or "Saved criteria are invalid.",
        )
    return list_catalog_photos(
        session, page=page, page_size=page_size, **query.model_dump()
    )
