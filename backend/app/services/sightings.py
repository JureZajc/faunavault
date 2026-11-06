from __future__ import annotations

import logging
import math
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, datetime, time

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import and_, delete, func, or_
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.models import Photo, Sighting, SightingPhoto, Taxon, utc_now
from app.schemas import TimelinePhotoPreview
from app.sighting_schemas import (
    SPECIES_RANKS,
    SightingCreate,
    SightingFields,
    SightingJournalPage,
    SightingPage,
    SightingPhotoPage,
    SightingRead,
    SightingSelection,
    SightingTaxon,
    SightingTaxonPage,
    SightingTotals,
    SightingUpdate,
)

logger = logging.getLogger(__name__)
PREVIEW_FIELDS = (
    Photo.id,
    Photo.thumbnail_filename,
    Photo.original_filename,
    Photo.display_title,
)


def _preview(row) -> TimelinePhotoPreview:
    return TimelinePhotoPreview.model_validate(
        dict(zip(TimelinePhotoPreview.model_fields, row, strict=True))
    )


def _sighting_or_404(session: Session, sighting_id: int) -> Sighting:
    item = session.get(Sighting, sighting_id)
    if item is None:
        raise HTTPException(404, "Sighting not found.")
    return item


@contextmanager
def _write(session: Session) -> Iterator[None]:
    # Lock before checking active photos, so Trash or purge cannot race validation.
    try:
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        yield
        session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        logger.exception("Sighting operation failed")
        raise HTTPException(500, "Could not save the Sighting operation.") from exc
    except Exception:
        session.rollback()
        raise


def _validate_taxon(session: Session, taxon_id: int | None) -> None:
    if taxon_id is None:
        return
    taxon = session.get(Taxon, taxon_id)
    if taxon is None:
        raise HTTPException(404, "Local taxon not found.")
    if taxon.taxonomic_rank.upper() not in SPECIES_RANKS:
        raise HTTPException(422, "Choose a verified species or subspecies.")


def _require_active_ids(photo_ids: list[int], rows) -> None:
    found = {row[0]: row[1] for row in rows}
    missing = sorted(set(photo_ids) - found.keys())
    if missing:
        raise HTTPException(404, f"Photos not found: {', '.join(map(str, missing))}.")
    trashed = sorted(
        photo_id for photo_id, deleted_at in found.items() if deleted_at is not None
    )
    if trashed:
        raise HTTPException(409, f"Photos in Trash: {', '.join(map(str, trashed))}.")


def _validate_photo_ids(session: Session, photo_ids: list[int]) -> None:
    _require_active_ids(
        photo_ids,
        session.exec(select(Photo.id, Photo.deleted_at).where(Photo.id.in_(photo_ids))),
    )


def describe_selection(session: Session, photo_ids: list[int]) -> SightingSelection:
    rows = session.exec(
        select(
            *PREVIEW_FIELDS,
            Photo.deleted_at,
            Photo.captured_at,
            Photo.captured_at_offset_minutes,
            Photo.latitude,
            Photo.longitude,
        )
        .where(Photo.id.in_(photo_ids))
        .order_by(Photo.id)
    ).all()
    _require_active_ids(photo_ids, ((row.id, row.deleted_at) for row in rows))
    times = {row.captured_at for row in rows}
    offsets = {row.captured_at_offset_minutes for row in rows}
    coordinates = {(row.latitude, row.longitude) for row in rows}
    observed_at = next(iter(times)) if len(times) == 1 else None
    latitude, longitude = (
        next(iter(coordinates)) if len(coordinates) == 1 else (None, None)
    )
    if latitude is None or longitude is None:
        latitude = longitude = None
    return SightingSelection(
        photo_count=len(rows),
        previews=[_preview(row[:4]) for row in rows[:12]],
        observed_at=observed_at,
        observed_at_offset_minutes=next(iter(offsets))
        if observed_at and len(offsets) == 1
        else None,
        latitude=latitude,
        longitude=longitude,
        capture_times_differ=len(times - {None}) > 1,
    )


def list_taxa(session: Session, *, search: str, page: int) -> SightingTaxonPage:
    name = func.coalesce(func.nullif(Taxon.common_name, ""), Taxon.canonical_name)
    query = select(Taxon).where(func.upper(Taxon.taxonomic_rank).in_(SPECIES_RANKS))
    if search.strip():
        term = search.strip().lower()
        query = query.where(
            or_(
                *(
                    func.faunavault_unicode_lower(field).contains(term, autoescape=True)
                    for field in (
                        Taxon.common_name,
                        Taxon.canonical_name,
                        Taxon.scientific_name,
                    )
                )
            )
        )
    page_size = 24
    items = session.exec(
        query.order_by(func.faunavault_unicode_lower(name), Taxon.id)
        .offset((page - 1) * page_size)
        .limit(page_size + 1)
    ).all()
    return SightingTaxonPage(
        items=[SightingTaxon.model_validate(item) for item in items[:page_size]],
        has_more=len(items) > page_size,
    )


def _summaries(session: Session, rows) -> list[SightingRead]:
    if not rows:
        return []
    identities = [item.id for item, _ in rows]
    active = Photo.deleted_at.is_(None)
    stats = {
        sighting_id: (active_count, total - active_count, representative_id)
        for sighting_id, active_count, total, representative_id in session.exec(
            select(
                SightingPhoto.sighting_id,
                func.count(Photo.id).filter(active),
                func.count(Photo.id),
                func.min(Photo.id).filter(active),
            )
            .join(Photo, Photo.id == SightingPhoto.photo_id)
            .where(SightingPhoto.sighting_id.in_(identities))
            .group_by(SightingPhoto.sighting_id)
        )
    }
    preview_ids = {
        photo_id for _, _, photo_id in stats.values() if photo_id is not None
    }
    previews = (
        {
            row.id: _preview(row)
            for row in session.exec(
                select(*PREVIEW_FIELDS).where(Photo.id.in_(preview_ids), active)
            )
        }
        if preview_ids
        else {}
    )
    items = []
    for item, taxon in rows:
        active_count, trash_count, preview_id = stats.get(item.id, (0, 0, None))
        items.append(
            SightingRead(
                **item.model_dump(),
                taxon=SightingTaxon.model_validate(taxon) if taxon else None,
                active_photo_count=active_count,
                trash_photo_count=trash_count,
                preview=previews.get(preview_id),
            )
        )
    return items


def _page(
    session: Session,
    conditions: list,
    *,
    newest: bool,
    page: int,
    page_size: int,
    total: int,
) -> SightingPage:
    order = (
        (Sighting.observed_at.desc(), Sighting.id.desc())
        if newest
        else (Sighting.observed_at, Sighting.id)
    )
    rows = session.exec(
        select(Sighting, Taxon)
        .outerjoin(Taxon, Taxon.id == Sighting.taxon_id)
        .where(*conditions)
        .order_by(*order)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return SightingPage(
        items=_summaries(session, rows),
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size),
    )


def list_sightings(
    session: Session,
    *,
    date_from: date | None,
    date_to: date | None,
    taxon_id: int | None,
    newest: bool,
    page: int,
    page_size: int,
) -> SightingJournalPage:
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(422, "Start date must be on or before end date.")
    date_conditions = []
    if date_from is not None:
        date_conditions.append(
            Sighting.observed_at >= datetime.combine(date_from, time.min)
        )
    if date_to is not None:
        date_conditions.append(
            Sighting.observed_at <= datetime.combine(date_to, time.max)
        )
    conditions = date_conditions.copy()
    if taxon_id is not None:
        conditions.append(Sighting.taxon_id == taxon_id)
    recorded, verified = session.exec(
        select(func.count(Sighting.id), func.count(Sighting.taxon_id))
    ).one()
    in_date_range = (
        session.exec(
            select(func.count(Sighting.id)).where(and_(*date_conditions))
        ).one()
        if date_conditions
        else recorded
    )
    total = (
        session.exec(select(func.count(Sighting.id)).where(*conditions)).one()
        if taxon_id is not None
        else in_date_range
    )
    result = _page(
        session, conditions, newest=newest, page=page, page_size=page_size, total=total
    )
    return SightingJournalPage(
        **result.model_dump(),
        totals=SightingTotals(
            recorded=recorded,
            in_date_range=in_date_range,
            verified=verified,
            unidentified=recorded - verified,
        ),
    )


def list_photo_sightings(
    session: Session, photo_id: int, *, page: int, page_size: int
) -> SightingPage:
    if (
        session.exec(
            select(Photo.id).where(Photo.id == photo_id, Photo.deleted_at.is_(None))
        ).first()
        is None
    ):
        raise HTTPException(404, "Photo not found.")
    membership = select(SightingPhoto.sighting_id).where(
        SightingPhoto.photo_id == photo_id
    )
    total = session.exec(
        select(func.count())
        .select_from(SightingPhoto)
        .where(SightingPhoto.photo_id == photo_id)
    ).one()
    return _page(
        session,
        [Sighting.id.in_(membership)],
        newest=True,
        page=page,
        page_size=page_size,
        total=total,
    )


def get_sighting(session: Session, sighting_id: int) -> SightingRead:
    row = session.exec(
        select(Sighting, Taxon)
        .outerjoin(Taxon, Taxon.id == Sighting.taxon_id)
        .where(Sighting.id == sighting_id)
    ).first()
    if row is None:
        raise HTTPException(404, "Sighting not found.")
    return _summaries(session, [row])[0]


def create_sighting(session: Session, request: SightingCreate) -> SightingRead:
    with _write(session):
        _validate_taxon(session, request.taxon_id)
        _validate_photo_ids(session, request.photo_ids)
        item = Sighting(**request.model_dump(exclude={"photo_ids"}))
        session.add(item)
        session.flush()
        sighting_id = item.id
        session.add_all(
            SightingPhoto(sighting_id=sighting_id, photo_id=photo_id)
            for photo_id in request.photo_ids
        )
        session.flush()
        result = get_sighting(session, sighting_id)
    return result


def update_sighting(
    session: Session, sighting_id: int, request: SightingUpdate
) -> SightingRead:
    with _write(session):
        item = _sighting_or_404(session, sighting_id)
        changes = request.model_dump(exclude_unset=True)
        try:
            SightingFields.model_validate(
                item.model_dump(include=set(SightingFields.model_fields)) | changes
            )
        except ValidationError as exc:
            raise HTTPException(422, exc.errors()[0]["msg"]) from exc
        if "taxon_id" in changes:
            _validate_taxon(session, request.taxon_id)
        item.sqlmodel_update(changes | {"updated_at": utc_now()})
        session.flush()
        result = get_sighting(session, sighting_id)
    return result


def delete_sighting(session: Session, sighting_id: int) -> None:
    with _write(session):
        session.delete(_sighting_or_404(session, sighting_id))


def list_photos(
    session: Session, sighting_id: int, *, page: int, page_size: int
) -> SightingPhotoPage:
    _sighting_or_404(session, sighting_id)
    conditions = (SightingPhoto.sighting_id == sighting_id, Photo.deleted_at.is_(None))
    total = session.exec(
        select(func.count(Photo.id))
        .join(SightingPhoto, SightingPhoto.photo_id == Photo.id)
        .where(*conditions)
    ).one()
    items = session.exec(
        select(Photo)
        .join(SightingPhoto, SightingPhoto.photo_id == Photo.id)
        .where(*conditions)
        .order_by(Photo.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return SightingPhotoPage(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size),
    )


def change_membership(
    session: Session, sighting_id: int, photo_ids: list[int], *, adding: bool
) -> SightingRead:
    with _write(session):
        item = _sighting_or_404(session, sighting_id)
        if adding:
            _validate_photo_ids(session, photo_ids)
        conditions = (
            SightingPhoto.sighting_id == sighting_id,
            SightingPhoto.photo_id.in_(photo_ids),
        )
        present = set(session.exec(select(SightingPhoto.photo_id).where(*conditions)))
        if adding and (new := set(photo_ids) - present):
            session.add_all(
                SightingPhoto(sighting_id=sighting_id, photo_id=photo_id)
                for photo_id in sorted(new)
            )
            item.updated_at = utc_now()
        elif not adding and present:
            session.exec(delete(SightingPhoto).where(*conditions))
            item.updated_at = utc_now()
        session.flush()
        result = get_sighting(session, sighting_id)
    return result
