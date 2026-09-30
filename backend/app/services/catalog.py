from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta

from sqlalchemy import Integer, String, and_, case, cast, func, or_
from sqlmodel import Session, select

from app.catalog_query import CatalogSavedQuery
from app.models import Animal, Photo, Taxon
from app.schemas import (
    CatalogCategoryFacet,
    CatalogFacets,
    CatalogPhotoPage,
    CatalogStatusCounts,
    CatalogTaxonOption,
    CatalogTaxonPage,
    PhotoMapPoint,
    TimelineMonth,
    TimelinePhotoPreview,
    TimelineResponse,
    TimelineYear,
)

TIMELINE_PREVIEW_LIMIT = 4

_PHOTO_SEARCH_FIELDS = (
    Photo.display_title,
    Photo.common_name,
    Photo.breed_guess,
    Photo.species_guess,
    Photo.category,
    Photo.description,
    Photo.original_filename,
    Photo.camera_make,
    Photo.camera_model,
    Photo.lens_model,
    cast(Photo.tags, String),
)
_ANIMAL_SEARCH_FIELDS = (
    Animal.display_name,
    Animal.identifier,
    Animal.legacy_common_name,
    Animal.legacy_species_name,
)
_TAXON_SEARCH_FIELDS = (
    Taxon.common_name,
    Taxon.scientific_name,
    Taxon.canonical_name,
    Taxon.kingdom,
    Taxon.phylum,
    Taxon.taxonomic_class,
    Taxon.taxonomic_order,
    Taxon.family,
    Taxon.genus,
    Taxon.species,
)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _term_condition(fields, term: str):
    pattern = f"%{_escape_like(term.lower())}%"
    return or_(
        *(
            func.lower(func.coalesce(field, "")).like(pattern, escape="\\")
            for field in fields
        )
    )


def _search_conditions(search: str) -> list:
    fields = (*_PHOTO_SEARCH_FIELDS, *_ANIMAL_SEARCH_FIELDS, *_TAXON_SEARCH_FIELDS)
    return [_term_condition(fields, term) for term in search.split()]


def _search_count_conditions(search: str) -> list:
    # Match each term independently: different terms can match different tables.
    conditions = []
    for term in search.split():
        taxon_ids = (
            select(Taxon.id)
            .where(_term_condition(_TAXON_SEARCH_FIELDS, term))
            .correlate(None)
        )
        animal_ids = (
            select(Animal.id)
            .where(
                or_(
                    _term_condition(_ANIMAL_SEARCH_FIELDS, term),
                    Animal.taxon_id.in_(taxon_ids),
                )
            )
            .correlate(None)
        )
        conditions.append(
            or_(
                _term_condition(_PHOTO_SEARCH_FIELDS, term),
                Photo.animal_id.in_(animal_ids),
            )
        )
    return conditions


def _active_photo_ids():
    # A covering active-ID lookup lets the outer query fetch Photos by rowid,
    # rather than traversing the capture index and fetching rows out of order.
    return select(Photo.id).where(Photo.deleted_at.is_(None)).correlate(None)


def _taxon_photo_ids(taxon_id: int):
    # No active predicate here: start with the existing relationship indexes.
    # The outer count applies active-photo exclusion and any search predicates.
    return (
        select(Photo.id)
        .select_from(Photo)
        .join(Animal, Photo.animal_id == Animal.id)
        .join(Taxon, Animal.taxon_id == Taxon.id)
        .where(Taxon.id == taxon_id)
        .correlate(None)
    )


def _name_expression():
    return func.coalesce(
        func.nullif(func.trim(Photo.display_title), ""),
        func.nullif(func.trim(Photo.breed_guess), ""),
        func.nullif(func.trim(Photo.common_name), ""),
        Photo.original_filename,
    ).collate("NOCASE")


def _species_expression():
    return func.coalesce(
        func.nullif(func.trim(Photo.species_guess), ""),
        Photo.original_filename,
    ).collate("NOCASE")


def _order_by(sort: str, order: str) -> list:
    direction = (
        (lambda value: value.asc()) if order == "asc" else (lambda value: value.desc())
    )
    filename = Photo.original_filename.collate("NOCASE").asc()

    if sort == "created_at":
        return [direction(Photo.created_at), direction(Photo.id)]
    if sort == "captured_at":
        return [
            case((Photo.captured_at.is_(None), 1), else_=0).asc(),
            direction(Photo.captured_at),
            direction(Photo.id),
        ]
    if sort == "name":
        return [
            direction(_name_expression()),
            Photo.created_at.desc(),
            filename,
            Photo.id.desc(),
        ]
    if sort == "species":
        return [
            direction(_species_expression()),
            Photo.created_at.desc(),
            filename,
            Photo.id.desc(),
        ]
    if sort == "confidence":
        return [
            case((Photo.confidence.is_(None), 1), else_=0).asc(),
            direction(Photo.confidence),
            Photo.created_at.desc(),
            filename,
            Photo.id.desc(),
        ]

    priority_status = "needs_review" if sort == "needs_review" else "pending"
    priority = case((Photo.status == priority_status, 1), else_=0)
    return [
        direction(priority),
        Photo.created_at.desc(),
        filename,
        Photo.id.desc(),
    ]


def get_catalog_facets(session: Session) -> CatalogFacets:
    active = Photo.deleted_at.is_(None)
    status_counts = {"pending": 0, "classified": 0, "needs_review": 0}
    for status, count in session.exec(
        select(Photo.status, func.count(Photo.id)).where(active).group_by(Photo.status)
    ).all():
        if status in status_counts:
            status_counts[status] = count

    category_rows = session.exec(
        select(Photo.category, func.count(Photo.id))
        .where(active)
        .group_by(Photo.category)
    ).all()
    categories: list[CatalogCategoryFacet] = []
    uncategorized_count = 0
    for value, count in category_rows:
        normalized = (value or "").strip()
        if not normalized:
            uncategorized_count += count
        else:
            categories.append(CatalogCategoryFacet(value=normalized, count=count))
    categories.sort(key=lambda item: (item.value.casefold(), item.value))

    return CatalogFacets(
        active_total=session.exec(select(func.count(Photo.id)).where(active)).one(),
        status_counts=CatalogStatusCounts(**status_counts),
        categories=categories,
        uncategorized_count=uncategorized_count,
    )


def _catalog_joins(query, criteria: CatalogSavedQuery):
    if criteria.taxon_id is not None:
        return query.join(Animal, Photo.animal_id == Animal.id).join(
            Taxon, Animal.taxon_id == Taxon.id
        )
    if criteria.search:
        return query.outerjoin(Animal, Photo.animal_id == Animal.id).outerjoin(
            Taxon, Animal.taxon_id == Taxon.id
        )
    return query


def _catalog_conditions(criteria: CatalogSavedQuery) -> list:
    conditions = [Photo.deleted_at.is_(None)]
    if criteria.search:
        conditions.extend(_search_conditions(criteria.search))
    if criteria.status:
        conditions.append(Photo.status == criteria.status)
    if criteria.uncategorized:
        conditions.append(
            or_(Photo.category.is_(None), func.trim(Photo.category) == "")
        )
    elif criteria.category:
        conditions.append(Photo.category == criteria.category)
    if criteria.taxon_id is not None:
        conditions.append(Taxon.id == criteria.taxon_id)
    if criteria.taken_from is not None:
        conditions.append(
            Photo.captured_at >= datetime.combine(criteria.taken_from, time.min)
        )
    if criteria.taken_to is not None:
        upper_bound = (
            datetime.max
            if criteria.taken_to == date.max
            else datetime.combine(criteria.taken_to + timedelta(days=1), time.min)
        )
        conditions.append(Photo.captured_at < upper_bound)
    return conditions


def list_catalog_photos(
    session: Session,
    *,
    page: int,
    page_size: int,
    search: str | None,
    status: str | None,
    category: str | None,
    uncategorized: bool,
    taxon_id: int | None,
    taken_from: date | None,
    taken_to: date | None,
    sort: str,
    order: str,
) -> CatalogPhotoPage:
    criteria = CatalogSavedQuery(
        search=search,
        status=status,
        category=category,
        uncategorized=uncategorized,
        taxon_id=taxon_id,
        taken_from=taken_from,
        taken_to=taken_to,
        sort=sort,
        order=order,
    )
    search = criteria.search
    has_search = bool(search)
    items_query = _catalog_joins(select(Photo).select_from(Photo), criteria)
    count_query = _catalog_joins(
        select(func.count(Photo.id)).select_from(Photo), criteria
    )
    conditions = _catalog_conditions(criteria)

    selective_photo_filters = bool(
        status
        or category
        or uncategorized
        or taken_from is not None
        or taken_to is not None
    )
    filtered_count = count_query.where(*conditions)
    # Keep selective Photo filters on their existing index paths. Broad text
    # counts instead reuse relationship matches, while Taxon counts start from
    # relationship IDs rather than looking up an Animal for every active Photo.
    if not selective_photo_filters:
        if taxon_id is not None:
            filtered_count = (
                select(func.count(Photo.id))
                .select_from(Photo)
                .where(
                    Photo.deleted_at.is_(None), Photo.id.in_(_taxon_photo_ids(taxon_id))
                )
            )
            if has_search:
                filtered_count = (
                    filtered_count.join(Animal, Photo.animal_id == Animal.id)
                    .join(Taxon, Animal.taxon_id == Taxon.id)
                    .where(*_search_conditions(search))
                )
        elif has_search:
            filtered_count = select(func.count(Photo.id)).where(
                Photo.id.in_(_active_photo_ids()), *_search_count_conditions(search)
            )
    total = session.exec(filtered_count).one()
    items = []
    if total:
        items = list(
            session.exec(
                items_query.where(*conditions)
                .order_by(*_order_by(sort, order))
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
        )
    return CatalogPhotoPage(
        items=items,
        page=page,
        page_size=page_size,
        total=total,
        total_pages=math.ceil(total / page_size) if total else 0,
        facets=get_catalog_facets(session),
    )


def list_photo_map_points(
    session: Session, criteria: CatalogSavedQuery | None = None
) -> list[PhotoMapPoint]:
    criteria = criteria or CatalogSavedQuery()
    query = _catalog_joins(
        select(
            Photo.id,
            Photo.latitude,
            Photo.longitude,
            Photo.thumbnail_filename,
            Photo.original_filename,
            Photo.display_title,
            Photo.common_name,
            Photo.species_guess,
            Photo.captured_at,
        ).select_from(Photo),
        criteria,
    )
    rows = session.exec(
        query.where(
            *_catalog_conditions(criteria),
            Photo.latitude.is_not(None),
            Photo.longitude.is_not(None),
        ).order_by(Photo.id.asc())
    ).all()
    return [
        PhotoMapPoint(
            id=row.id,
            latitude=row.latitude,
            longitude=row.longitude,
            thumbnail_filename=row.thumbnail_filename,
            original_filename=row.original_filename,
            display_title=row.display_title,
            common_name=row.common_name,
            species_guess=row.species_guess,
            captured_at=row.captured_at,
        )
        for row in rows
    ]


def get_photo_timeline(session: Session) -> TimelineResponse:
    capture_year = cast(func.strftime("%Y", Photo.captured_at), Integer).label(
        "capture_year"
    )
    capture_month = cast(func.strftime("%m", Photo.captured_at), Integer).label(
        "capture_month"
    )
    active_known = (
        Photo.deleted_at.is_(None),
        Photo.captured_at.is_not(None),
    )

    month_rows = session.exec(
        select(capture_year, capture_month, func.count(Photo.id).label("photo_count"))
        .where(*active_known)
        .group_by(capture_year, capture_month)
        .order_by(capture_year.desc(), capture_month.desc())
    ).all()
    unknown_capture_count = session.exec(
        select(func.count(Photo.id)).where(
            Photo.deleted_at.is_(None),
            Photo.captured_at.is_(None),
        )
    ).one()

    preview_rank = (
        func.row_number()
        .over(
            partition_by=(capture_year, capture_month),
            order_by=(Photo.captured_at.desc(), Photo.id.desc()),
        )
        .label("preview_rank")
    )
    ranked_previews = (
        select(
            capture_year,
            capture_month,
            Photo.id.label("photo_id"),
            Photo.thumbnail_filename,
            Photo.original_filename,
            Photo.display_title,
            preview_rank,
        )
        .where(*active_known)
        .subquery()
    )
    preview_rows = session.exec(
        select(
            ranked_previews.c.capture_year,
            ranked_previews.c.capture_month,
            ranked_previews.c.photo_id,
            ranked_previews.c.thumbnail_filename,
            ranked_previews.c.original_filename,
            ranked_previews.c.display_title,
            ranked_previews.c.preview_rank,
        )
        .where(ranked_previews.c.preview_rank <= TIMELINE_PREVIEW_LIMIT)
        .order_by(
            ranked_previews.c.capture_year.desc(),
            ranked_previews.c.capture_month.desc(),
            ranked_previews.c.preview_rank.asc(),
        )
    ).all()

    previews_by_month: dict[tuple[int, int], list[TimelinePhotoPreview]] = {}
    for row in preview_rows:
        key = (int(row.capture_year), int(row.capture_month))
        previews_by_month.setdefault(key, []).append(
            TimelinePhotoPreview(
                id=row.photo_id,
                thumbnail_filename=row.thumbnail_filename,
                original_filename=row.original_filename,
                display_title=row.display_title,
            )
        )

    month_counts = {
        (int(row.capture_year), int(row.capture_month)): int(row.photo_count)
        for row in month_rows
    }
    years: list[TimelineYear] = []
    for year in sorted({year for year, _month in month_counts}, reverse=True):
        months = [
            TimelineMonth(
                month=month,
                photo_count=month_counts[(year, month)],
                previews=previews_by_month.get((year, month), []),
            )
            for month in sorted(
                (
                    month
                    for candidate_year, month in month_counts
                    if candidate_year == year
                ),
                reverse=True,
            )
        ]
        years.append(
            TimelineYear(
                year=year,
                photo_count=sum(month.photo_count for month in months),
                months=months,
            )
        )

    return TimelineResponse(
        years=years,
        unknown_capture_count=unknown_capture_count,
    )


def _taxon_option(taxon_id: int, label: str, scientific_name: str, count: int):
    return CatalogTaxonOption(
        taxon_id=taxon_id,
        label=label,
        scientific_name=scientific_name,
        count=count,
    )


def list_catalog_taxa(
    session: Session,
    *,
    page: int,
    page_size: int,
    include_id: int | None,
) -> CatalogTaxonPage:
    label = func.coalesce(
        func.nullif(func.trim(Taxon.common_name), ""),
        func.nullif(func.trim(Taxon.canonical_name), ""),
        Taxon.scientific_name,
    )
    active_join = and_(Photo.animal_id == Animal.id, Photo.deleted_at.is_(None))
    counts = (
        select(
            Animal.taxon_id.label("taxon_id"),
            func.count(Photo.id).label("photo_count"),
        )
        .select_from(Photo)
        .join(Animal, Photo.animal_id == Animal.id)
        .where(Photo.id.in_(_active_photo_ids()), Animal.taxon_id.is_not(None))
        .group_by(Animal.taxon_id)
        .subquery()
    )
    total = session.exec(
        select(func.count(Taxon.id)).join(counts, counts.c.taxon_id == Taxon.id)
    ).one()
    rows = session.exec(
        select(
            Taxon.id, label.label("label"), Taxon.scientific_name, counts.c.photo_count
        )
        .join(counts, counts.c.taxon_id == Taxon.id)
        .order_by(
            label.collate("NOCASE"),
            Taxon.scientific_name.collate("NOCASE"),
            Taxon.id,
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    items = [_taxon_option(*row) for row in rows]

    selected = None
    if include_id is not None:
        selected_row = session.exec(
            select(
                Taxon.id,
                label.label("label"),
                Taxon.scientific_name,
                func.count(Photo.id).label("photo_count"),
            )
            .select_from(Taxon)
            .outerjoin(Animal, Animal.taxon_id == Taxon.id)
            .outerjoin(Photo, active_join)
            .where(Taxon.id == include_id)
            .group_by(Taxon.id, label, Taxon.scientific_name)
        ).first()
        if selected_row is not None:
            selected = _taxon_option(*selected_row)

    return CatalogTaxonPage(
        items=items,
        selected=selected,
        page=page,
        page_size=page_size,
        total=total,
        total_pages=math.ceil(total / page_size) if total else 0,
    )
