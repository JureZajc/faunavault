from datetime import datetime
from math import ceil

from sqlalchemy import Integer, func, literal, true
from sqlmodel import Session, select

from app.life_list_schemas import (
    LifeListMode,
    LifeListOrder,
    LifeListPage,
    LifeListSummary,
    LifeListTaxon,
)
from app.models import Photo, Sighting, SightingPhoto, Taxon
from app.services.sightings import PREVIEW_FIELDS, photo_preview, taxon_name_matches
from app.sighting_schemas import SPECIES_RANKS


def _verified_observations(*columns):
    return (
        select(*columns)
        .select_from(Taxon)
        .join(Sighting, Sighting.taxon_id == Taxon.id)
        .where(func.upper(Taxon.taxonomic_rank).in_(SPECIES_RANKS))
    )


def _sighting_at(page_rows, timestamp):
    return (
        select(func.min(Sighting.id))
        .where(
            Sighting.taxon_id == page_rows.c.taxon_id, Sighting.observed_at == timestamp
        )
        .correlate(page_rows)
        .scalar_subquery()
    )


def _preview_id(page_rows):
    return (
        select(SightingPhoto.photo_id)
        .select_from(Sighting)
        .join(SightingPhoto, SightingPhoto.sighting_id == Sighting.id)
        .join(Photo, Photo.id == SightingPhoto.photo_id)
        .where(Sighting.taxon_id == page_rows.c.taxon_id, Photo.deleted_at.is_(None))
        .order_by(Sighting.observed_at, Sighting.id, SightingPhoto.photo_id)
        .limit(1)
        .correlate(page_rows)
        .scalar_subquery()
    )


def list_life_list(
    session: Session,
    *,
    year: int | None,
    mode: LifeListMode,
    search: str,
    sort: LifeListOrder,
    page: int,
    page_size: int,
) -> LifeListPage:
    in_year = (
        Sighting.observed_at.between(
            datetime(year, 1, 1), datetime(year, 12, 31, 23, 59, 59, 999999)
        )
        if year is not None
        else true()
    )
    stats = (
        _verified_observations(
            Taxon.id.label("taxon_id"),
            Taxon.common_name,
            Taxon.canonical_name,
            Taxon.scientific_name,
            Taxon.taxonomic_rank,
            func.min(Sighting.observed_at).label("first_observed_at"),
            func.max(Sighting.observed_at).label("last_observed_at"),
            func.count().label("sighting_count"),
            func.count().filter(in_year).label("scope_count"),
        )
        .group_by(Taxon.id)
        .subquery()
    )
    fields = stats.c
    seen = fields.scope_count > 0
    new = func.substr(fields.first_observed_at, 1, 4) == f"{year or 0:04d}"
    matches = true() if year is None else (new if mode == "new" else seen)
    if search.strip():
        matches &= taxon_name_matches(
            search, fields.common_name, fields.canonical_name, fields.scientific_name
        )
    all_taxa, all_sightings, seen_taxa, new_taxa, total, scope_sightings = session.exec(
        select(
            func.count(),
            func.coalesce(func.sum(fields.sighting_count), 0),
            func.count().filter(seen) if year is not None else literal(None),
            func.count().filter(new) if year is not None else literal(None),
            func.count().filter(matches),
            func.coalesce(func.sum(fields.scope_count).filter(matches), 0),
        ).select_from(stats)
    ).one()

    items = []
    offset = (page - 1) * page_size
    if offset < total:
        name = func.faunavault_unicode_lower(
            func.coalesce(func.nullif(fields.common_name, ""), fields.canonical_name)
        )
        sort_key = {
            "name": name,
            "first_observed": fields.first_observed_at,
            "most_observed": fields.sighting_count,
        }[sort]
        descending = sort == "most_observed"
        # Page before looking up encounter IDs and active thumbnails.
        page_rows = (
            select(
                fields.taxon_id,
                fields.common_name,
                fields.scientific_name,
                fields.taxonomic_rank,
                fields.first_observed_at,
                fields.last_observed_at,
                fields.sighting_count,
                sort_key.label("sort_key"),
            )
            .where(matches)
            .order_by(sort_key.desc() if descending else sort_key, fields.taxon_id)
            .offset(offset)
            .limit(page_size)
            .subquery()
        )
        rows = session.exec(
            select(
                *page_rows.c,
                _sighting_at(page_rows, page_rows.c.first_observed_at).label(
                    "first_sighting_id"
                ),
                _sighting_at(page_rows, page_rows.c.last_observed_at).label(
                    "last_sighting_id"
                ),
                *PREVIEW_FIELDS,
            )
            .select_from(page_rows)
            .outerjoin(Photo, Photo.id == _preview_id(page_rows))
            .order_by(
                page_rows.c.sort_key.desc() if descending else page_rows.c.sort_key,
                page_rows.c.taxon_id,
            )
        )
        items = [
            LifeListTaxon(
                **row._mapping,
                preview=photo_preview(row[-len(PREVIEW_FIELDS) :])
                if row.id is not None
                else None,
            )
            for row in rows
        ]

    observation_year = func.substr(Sighting.observed_at, 1, 4).cast(Integer)
    years = session.exec(
        _verified_observations(observation_year)
        .distinct()
        .order_by(observation_year.desc())
    ).all()
    return LifeListPage(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=ceil(total / page_size),
        year=year,
        available_years=years,
        summary=LifeListSummary(
            all_time_taxa=all_taxa,
            all_time_sightings=all_sightings,
            seen_taxa=seen_taxa,
            new_taxa=new_taxa,
            scope_sightings=scope_sightings,
        ),
    )
