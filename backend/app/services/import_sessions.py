from __future__ import annotations

import math
from uuid import UUID, uuid4

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, func, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import ImportSession, Photo, utc_now

OUTCOME_FIELDS = (
    "duplicate_count",
    "visual_duplicate_skipped_count",
    "unsupported_count",
    "failed_count",
)


def canonical_session_id(value: str) -> str:
    try:
        return str(UUID(value))
    except (ValueError, AttributeError) as exc:
        raise ValueError("Import Session ID must be a UUID") from exc


class ImportSessionStart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str

    _id = field_validator("id")(canonical_session_id)


class ImportSessionOutcomes(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    duplicate_count: int = Field(ge=0)
    visual_duplicate_skipped_count: int = Field(ge=0)
    unsupported_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)


class ImportSessionRead(ImportSession):
    active_count: int = 0
    trash_count: int = 0
    undecided_count: int = 0
    pick_count: int = 0
    reject_count: int = 0


class ImportSessionPage(BaseModel):
    items: list[ImportSessionRead]
    total: int
    page: int
    page_size: int
    total_pages: int


def get_import_session(
    session: Session, session_id: str, source_kind: str | None = None
) -> ImportSession:
    item = session.get(ImportSession, session_id)
    if item is None:
        raise HTTPException(404, detail="Import Session not found")
    if source_kind is not None and item.source_kind != source_kind:
        raise HTTPException(409, detail="Import Session has a different source kind")
    return item


def start_import_session(
    session: Session,
    source_kind: str,
    *,
    session_id: str | None = None,
    label: str | None = None,
) -> ImportSession:
    identity = session_id or str(uuid4())
    item = session.get(ImportSession, identity)
    if item is None:
        item = ImportSession(id=identity, source_kind=source_kind, label=label)
        session.add(item)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            item = get_import_session(session, identity, source_kind)
    else:
        get_import_session(session, identity, source_kind)
    if item.completed_at is not None:
        item.completed_at = None
        for field in OUTCOME_FIELDS:
            setattr(item, field, None)
        session.add(item)
        session.commit()
    session.refresh(item)
    return item


def complete_import_session(
    session: Session,
    session_id: str,
    outcomes: ImportSessionOutcomes,
    *,
    source_kind: str | None = None,
) -> ImportSession:
    item = get_import_session(session, session_id, source_kind)
    values = outcomes.model_dump()
    if item.completed_at is not None:
        if any(getattr(item, key) != value for key, value in values.items()):
            raise HTTPException(
                409, detail="Start the Import Session before changing its outcomes"
            )
        return item
    for key, value in values.items():
        setattr(item, key, value)
    item.completed_at = utc_now()
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


def record_imported_photo(session: Session, session_id: str) -> None:
    # The increment and Photo creation share the ingestion transaction.
    result = session.exec(
        update(ImportSession)
        .where(ImportSession.id == session_id, ImportSession.completed_at.is_(None))
        .values(imported_count=ImportSession.imported_count + 1)
    )
    if result.rowcount != 1:
        raise HTTPException(409, detail="Import Session is already finalized")


def session_counts(
    session: Session, identities: list[str]
) -> dict[str, dict[str, int]]:
    if not identities:
        return {}
    active = Photo.deleted_at.is_(None)
    rows = session.exec(
        select(
            Photo.import_session_id,
            func.sum(case((active, 1), else_=0)),
            func.sum(case((Photo.deleted_at.is_not(None), 1), else_=0)),
            func.sum(case((active & Photo.culling_state.is_(None), 1), else_=0)),
            func.sum(case((active & (Photo.culling_state == "pick"), 1), else_=0)),
            func.sum(case((active & (Photo.culling_state == "reject"), 1), else_=0)),
        )
        .where(Photo.import_session_id.in_(identities))
        .group_by(Photo.import_session_id)
    ).all()
    keys = (
        "active_count",
        "trash_count",
        "undecided_count",
        "pick_count",
        "reject_count",
    )
    return {row[0]: dict(zip(keys, row[1:], strict=True)) for row in rows}


def read_import_session(session: Session, session_id: str) -> ImportSessionRead:
    item = get_import_session(session, session_id)
    return ImportSessionRead(
        **item.model_dump(), **session_counts(session, [session_id]).get(session_id, {})
    )


def list_import_sessions(
    session: Session, page: int, page_size: int
) -> ImportSessionPage:
    total = session.exec(select(func.count()).select_from(ImportSession)).one()
    items = session.exec(
        select(ImportSession)
        .order_by(ImportSession.started_at.desc(), ImportSession.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    counts = session_counts(session, [item.id for item in items])
    return ImportSessionPage(
        items=[
            ImportSessionRead(**item.model_dump(), **counts.get(item.id, {}))
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size),
    )
