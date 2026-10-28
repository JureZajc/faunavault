"""Archive-wide tag changes, with bounded memory and signed snapshot previews."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time

from fastapi import HTTPException
from sqlalchemy import String, bindparam, cast, or_, update
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlmodel import Session, select

from app.models import Photo, utc_now
from app.schemas import (
    TagOperationApplyRequest,
    TagOperationExample,
    TagOperationPreview,
    TagOperationRequest,
    TagOperationResult,
)
from app.services.catalog import _tag_entries, _tag_name

BATCH_SIZE = 250
PREVIEW_SECONDS = 15 * 60
# Local single-process API: restarting the backend invalidates outstanding previews.
_PREVIEW_KEY = secrets.token_bytes(32)


def _error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message})


def _membership(tag: str):
    entries = _tag_entries()
    return (
        select(1)
        .select_from(entries)
        .where(entries.c.type == "text", _tag_name(entries) == tag)
        .correlate(Photo)
        .exists()
    )


def _rows(session: Session, request: TagOperationRequest):
    match = _membership(request.source)
    if request.destination is not None:
        match = or_(match, _membership(request.destination))
    # Cast bypasses PhotoTagsJSON's normalizing read adapter: preserve unrelated
    # legacy values, spacing and duplicates rather than repairing them globally.
    query = (
        select(
            Photo.id,
            cast(Photo.tags, String).label("raw_tags"),
            Photo.deleted_at,
            Photo.updated_at,
            Photo.original_filename,
        )
        .where(match)
        .order_by(Photo.id)
        .execution_options(yield_per=BATCH_SIZE)
    )
    return session.exec(query)


def _transform(tags: list, request: TagOperationRequest) -> list:
    source, destination = request.source, request.destination
    has_destination = destination is not None and any(
        isinstance(tag, str) and tag.strip() == destination for tag in tags
    )
    result = []
    placed = False
    for tag in tags:
        name = tag.strip() if isinstance(tag, str) else None
        if name == source:
            if destination is not None and not has_destination and not placed:
                result.append(destination)
                placed = True
        elif destination is not None and name == destination:
            if not placed:
                result.append(destination)
                placed = True
        else:
            result.append(tag)
    return result


def _snapshot(session: Session, request: TagOperationRequest):
    digest = hashlib.sha256()
    active = trashed = overlap = 0
    destination_exists = False
    examples = []
    rows = _rows(session, request)
    try:
        for row in rows:
            digest.update(
                json.dumps(list(row), default=str, ensure_ascii=True).encode()
            )
            tags = json.loads(row.raw_tags)
            names = {tag.strip() for tag in tags if isinstance(tag, str)}
            contains_destination = request.destination in names
            destination_exists |= contains_destination
            if request.source not in names:
                continue
            active += row.deleted_at is None
            trashed += row.deleted_at is not None
            overlap += contains_destination
            if len(examples) < 5:
                examples.append(
                    TagOperationExample(
                        photo_id=row.id,
                        filename=row.original_filename,
                        trashed=row.deleted_at is not None,
                        before=tags,
                        after=_transform(tags, request),
                    )
                )
    finally:
        rows.close()
    return dict(
        active_photos=active,
        trashed_photos=trashed,
        destination_overlap=overlap,
        total_photos=active + trashed,
        destination_exists=destination_exists,
        examples=examples,
    ), digest.hexdigest()


def _signature(request: TagOperationRequest, digest: str, expires: int) -> str:
    payload = json.dumps(
        [request.operation, request.source, request.destination, digest, expires]
    )
    return hmac.new(_PREVIEW_KEY, payload.encode(), hashlib.sha256).hexdigest()


def _validate_exists(request, data):
    if not data["total_photos"]:
        raise _error(
            404, "source_not_found", "The source tag no longer exists in the archive."
        )
    if request.operation == "merge" and not data["destination_exists"]:
        raise _error(
            422,
            "destination_not_found",
            "Choose an existing archive tag to merge into.",
        )


def preview_tag_operation(
    session: Session, request: TagOperationRequest
) -> TagOperationPreview:
    try:
        # Explicit BEGIN also gives SELECTs a stable snapshot under sqlite3's
        # legacy transaction mode. Preview never acquires a write reservation.
        session.connection().exec_driver_sql("BEGIN")
        data, digest = _snapshot(session, request)
        _validate_exists(request, data)
        expires = int(time.time()) + PREVIEW_SECONDS
        token = f"{expires}.{digest}.{_signature(request, digest, expires)}"
        return TagOperationPreview(**request.model_dump(), **data, preview_token=token)
    except OperationalError as exc:
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise _error(
                409, "archive_busy", "Archive is busy. Retry Preview shortly."
            ) from exc
        raise _error(
            500, "tag_preview_failed", "Could not preview archive tags."
        ) from exc
    except SQLAlchemyError as exc:
        raise _error(
            500, "tag_preview_failed", "Could not preview archive tags."
        ) from exc
    finally:
        session.rollback()


def apply_tag_operation(
    session: Session, request: TagOperationApplyRequest
) -> TagOperationResult:
    if request.operation == "delete" and not request.confirm_delete:
        raise _error(
            422,
            "delete_confirmation_required",
            "Confirm removal from the entire archive, including Trash.",
        )
    try:
        expires_text, expected_digest, signature = request.preview_token.split(".")
        expires = int(expires_text)
        valid = hmac.compare_digest(
            signature, _signature(request, expected_digest, expires)
        )
    except (ValueError, TypeError):
        valid = False
        expires = 0
    if not valid:
        raise _error(409, "invalid_preview", "Preview is invalid. Retry Preview.")
    if expires <= time.time():
        raise _error(409, "stale_preview", "Preview expired. Retry Preview.")
    try:
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        data, digest = _snapshot(session, request)
        if digest != expected_digest or expires <= time.time():
            raise _error(
                409,
                "stale_preview",
                "Archive tags changed. Retry Preview before confirming.",
            )
        _validate_exists(request, data)
        now = utc_now()
        # Finish the snapshot cursor before updating, then process bounded pages
        # by ID; no offset skips rows as their source tag disappears.
        last_id = 0
        statement = (
            update(Photo.__table__)
            .where(Photo.id == bindparam("target_photo_id"))
            .values(tags=bindparam("new_tags"), updated_at=now)
        )
        while True:
            entries = session.exec(
                select(Photo.id, cast(Photo.tags, String))
                .where(Photo.id > last_id, _membership(request.source))
                .order_by(Photo.id)
                .limit(BATCH_SIZE)
            ).all()
            if not entries:
                break
            changes = []
            for photo_id, raw_tags in entries:
                before = json.loads(raw_tags)
                after = _transform(before, request)
                if before != after:
                    changes.append({"target_photo_id": photo_id, "new_tags": after})
            if changes:
                session.connection().execute(statement, changes)
            last_id = entries[-1][0]
        session.commit()
        return TagOperationResult(
            operation=request.operation,
            source=request.source,
            destination=request.destination,
            updated_photos=data["total_photos"],
            active_photos=data["active_photos"],
            trashed_photos=data["trashed_photos"],
        )
    except OperationalError as exc:
        session.rollback()
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            raise _error(
                409, "archive_busy", "Archive is busy. Retry Preview shortly."
            ) from exc
        raise _error(
            500, "tag_operation_failed", "Tag operation failed; no changes were saved."
        ) from exc
    except SQLAlchemyError as exc:
        session.rollback()
        raise _error(
            500, "tag_operation_failed", "Tag operation failed; no changes were saved."
        ) from exc
    except Exception:
        session.rollback()
        raise
