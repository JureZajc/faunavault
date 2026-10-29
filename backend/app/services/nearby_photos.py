"""Read-only, bounded-memory nearby previews from effective GPS metadata."""

import heapq

from fastapi import HTTPException
from sqlmodel import Session, select

from app.models import Photo
from app.schemas import NearbyPhotoPreview, NearbyPhotosResponse
from app.services.geography import (
    DISTANCE_TOLERANCE_M,
    bounding_box_condition,
    great_circle_distance_m,
    radius_bounds,
    valid_coordinates,
)

CANDIDATE_BATCH_SIZE = 256


def nearby_photos(
    session: Session, photo_id: int, radius_km: int = 5, limit: int = 12
) -> NearbyPhotosResponse:
    source = session.exec(
        select(Photo.latitude, Photo.longitude).where(
            Photo.id == photo_id, Photo.deleted_at.is_(None)
        )
    ).first()
    if source is None:
        raise HTTPException(404, detail="Photo not found")
    response = NearbyPhotosResponse(source_photo_id=photo_id, radius_km=radius_km)
    if not valid_coordinates(*source):
        response.availability = "unavailable"
        response.unavailable_reason = "missing_or_invalid_gps"
        return response

    radius_m = radius_km * 1000
    query = select(
        Photo.id,
        Photo.thumbnail_filename,
        Photo.original_filename,
        Photo.display_title,
        Photo.breed_guess,
        Photo.common_name,
        Photo.captured_at,
        Photo.latitude,
        Photo.longitude,
    ).where(
        Photo.deleted_at.is_(None),
        Photo.id != photo_id,
        bounding_box_condition(*radius_bounds(*source, radius_m)),
    )
    candidates = session.exec(query.execution_options(yield_per=CANDIDATE_BATCH_SIZE))

    def matches():
        for row in candidates:
            distance = great_circle_distance_m(*source, row.latitude, row.longitude)
            if distance > radius_m + DISTANCE_TOLERANCE_M:
                continue
            response.total += 1
            captured = row.captured_at
            # Camera-local time, descending, NULLS LAST; no host timezone conversion.
            stamp = (
                (
                    ((captured.toordinal() * 24 + captured.hour) * 60 + captured.minute)
                    * 60
                    + captured.second
                )
                * 1_000_000
                + captured.microsecond
                if captured
                else 0
            )
            yield (distance, captured is None, -stamp, row.id), row

    try:
        # nsmallest maintains a heap of at most limit entries, regardless of density.
        nearest = heapq.nsmallest(limit, matches(), key=lambda item: item[0])
    finally:
        candidates.close()
    response.items = [
        NearbyPhotoPreview(
            id=row.id,
            thumbnail_filename=row.thumbnail_filename,
            original_filename=row.original_filename,
            display_title=next(
                (
                    value.strip()
                    for value in (row.display_title, row.breed_guess, row.common_name)
                    if value and value.strip()
                ),
                None,
            ),
            captured_at=row.captured_at,
            distance_m=key[0],
        )
        for key, row in nearest
    ]
    return response
