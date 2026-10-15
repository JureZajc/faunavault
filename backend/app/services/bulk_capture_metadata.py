from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app.config import Settings
from app.models import Photo, utc_now
from app.schemas import (
    BulkCaptureApplyRequest,
    BulkCaptureApplyResponse,
    BulkCapturePreviewRequest,
    BulkCapturePreviewResponse,
    CaptureMetadataValues,
    CapturePreviewIssue,
    CapturePreviewPhoto,
    ClearCaptureTime,
    PhotoUpdate,
    RemoveCaptureGPS,
    RestoreCaptureMetadata,
    SetCaptureGPS,
    SetCaptureTime,
    ShiftCaptureTime,
)
from app.services.bulk_photos import _bulk_error, _load_active_photos, _validate_ids
from app.services.capture_metadata import read_verified_original_capture_metadata

logger = logging.getLogger(__name__)
CAPTURE_GROUP = ("captured_at", "captured_at_offset_minutes")
LOCATION_GROUP = ("latitude", "longitude")


def _plan(photo: Photo, request: BulkCapturePreviewRequest, settings: Settings):
    """Calculate and validate without mutating the ORM object or retained metadata."""
    change = request.change
    updates = {}
    digest = None
    if isinstance(change, ShiftCaptureTime):
        if photo.captured_at is None:
            raise _bulk_error(
                422,
                "missing_capture_time",
                "No capture timestamp to shift. Deselect this photo or set its capture time first.",
            )
        try:
            captured = photo.captured_at + timedelta(minutes=change.minutes)
        except (OverflowError, ValueError) as exc:
            raise _bulk_error(
                422,
                "capture_time_overflow",
                "Shift would exceed the supported date range (years 1–9999).",
            ) from exc
        updates = {
            "captured_at": captured,
            "captured_at_offset_minutes": photo.captured_at_offset_minutes,
            "capture_metadata_overridden": True,
        }
    elif isinstance(change, SetCaptureTime):
        updates = {
            "captured_at": change.captured_at,
            "captured_at_offset_minutes": photo.captured_at_offset_minutes
            if change.offset_mode == "preserve"
            else change.captured_at_offset_minutes,
            "capture_metadata_overridden": True,
        }
    elif isinstance(change, ClearCaptureTime):
        updates = {
            "captured_at": None,
            "captured_at_offset_minutes": None,
            "capture_metadata_overridden": True,
        }
    elif isinstance(change, (SetCaptureGPS, RemoveCaptureGPS)):
        updates = {
            "latitude": change.latitude if isinstance(change, SetCaptureGPS) else None,
            "longitude": change.longitude
            if isinstance(change, SetCaptureGPS)
            else None,
            "location_metadata_overridden": True,
        }
    elif isinstance(change, RestoreCaptureMetadata):
        extracted, digest = read_verified_original_capture_metadata(photo, settings)
        groups = []
        if change.group in ("capture", "both"):
            groups.extend(CAPTURE_GROUP)
            updates["capture_metadata_overridden"] = False
        if change.group in ("location", "both"):
            groups.extend(LOCATION_GROUP)
            updates["location_metadata_overridden"] = False
        for name in groups:
            updates[name] = updates[f"extracted_{name}"] = getattr(extracted, name)

    # Reuse the single-photo validation for all calculated effective values.
    effective = {
        name: updates.get(name, getattr(photo, name))
        for name in (*CAPTURE_GROUP, *LOCATION_GROUP)
    }
    PhotoUpdate.model_validate(
        {
            **effective,
            "captured_at": effective["captured_at"].isoformat()
            if effective["captured_at"] is not None
            else None,
        }
    )
    return updates, digest


def _preview(
    photos: list[Photo], request: BulkCapturePreviewRequest, settings: Settings
):
    rows = []
    plans = []
    for photo in photos:
        before = CaptureMetadataValues.model_validate(photo, from_attributes=True)
        try:
            updates, digest = _plan(photo, request, settings)
        except HTTPException as exc:
            detail = (
                exc.detail
                if isinstance(exc.detail, dict)
                else {"code": "invalid_metadata", "message": str(exc.detail)}
            )
            rows.append(
                CapturePreviewPhoto(
                    photo_id=photo.id,
                    filename=photo.original_filename,
                    updated_at=photo.updated_at.isoformat(),
                    before=before,
                    after=None,
                    changed=False,
                    issue=CapturePreviewIssue(**detail),
                )
            )
            plans.append({})
            continue
        changed = any(getattr(photo, name) != value for name, value in updates.items())
        after = CaptureMetadataValues.model_validate(
            {
                **before.model_dump(),
                **{
                    name: value
                    for name, value in updates.items()
                    if name in CaptureMetadataValues.model_fields
                },
            }
        )
        rows.append(
            CapturePreviewPhoto(
                photo_id=photo.id,
                filename=photo.original_filename,
                updated_at=photo.updated_at.isoformat(),
                original_sha256=digest,
                before=before,
                after=after,
                changed=changed,
            )
        )
        plans.append(updates)
    blocked = sum(row.issue is not None for row in rows)
    return BulkCapturePreviewResponse(
        change=request.change,
        selected_count=len(rows),
        affected_count=sum(row.changed for row in rows),
        blocked_count=blocked,
        can_apply=blocked == 0,
        photos=rows,
    ), plans


def preview_bulk_capture_metadata(
    request: BulkCapturePreviewRequest, session: Session, settings: Settings
) -> BulkCapturePreviewResponse:
    _validate_ids(request.photo_ids)
    photos = _load_active_photos(request.photo_ids, session)
    return _preview(photos, request, settings)[0]


def apply_bulk_capture_metadata(
    request: BulkCaptureApplyRequest, session: Session, settings: Settings
) -> BulkCaptureApplyResponse:
    _validate_ids(request.photo_ids)
    versions = {version.photo_id: version for version in request.expected_versions}
    if len(versions) != len(request.expected_versions) or set(versions) != set(
        request.photo_ids
    ):
        raise _bulk_error(
            422,
            "invalid_expected_versions",
            "Provide exactly one preview version for every selected photo.",
        )
    try:
        # SQLite is the supported database. Acquire its writer lock BEFORE reading
        # versions, and hold it through validation, restoration, mutation and commit.
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        photos = _load_active_photos(request.photo_ids, session)
        stale = [
            photo.id
            for photo in photos
            if photo.updated_at.isoformat() != versions[photo.id].updated_at
        ]
        if stale:
            raise _bulk_error(
                409,
                "photos_changed",
                "Selected photos changed since preview. Preview again before applying.",
                photo_ids=stale,
            )
        preview, plans = _preview(photos, request, settings)
        if not preview.can_apply:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "capture_operation_blocked",
                    "message": f"{preview.blocked_count} photos cannot be processed. No changes applied. Resolve the issues and preview again.",
                    "photos": [
                        row.model_dump(mode="json")
                        for row in preview.photos
                        if row.issue
                    ],
                },
            )
        if isinstance(request.change, RestoreCaptureMetadata):
            changed_originals = [
                row.photo_id
                for row in preview.photos
                if row.original_sha256 != versions[row.photo_id].original_sha256
            ]
            if changed_originals:
                raise _bulk_error(
                    409,
                    "originals_changed",
                    "Original files changed or their preview checksums are missing. Preview again before restoring.",
                    photo_ids=changed_originals,
                )
        now = utc_now()
        for photo, row, updates in zip(photos, preview.photos, plans, strict=True):
            if row.changed:
                for name, value in updates.items():
                    setattr(photo, name, value)
                photo.updated_at = now
                session.add(photo)
        session.commit()
        return BulkCaptureApplyResponse(
            photo_ids=request.photo_ids, affected_count=preview.affected_count
        )
    except HTTPException:
        session.rollback()
        raise
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Bulk capture metadata operation failed")
        raise _bulk_error(
            500,
            "bulk_operation_failed",
            "Could not apply metadata changes. Preview again before retrying.",
        ) from exc
