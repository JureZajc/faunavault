from __future__ import annotations

import math

from sqlalchemy import String, and_, case, cast, func, or_
from sqlmodel import Session, select

from app.models import Animal, Photo, Taxon
from app.schemas import (
    CatalogCategoryFacet,
    CatalogFacets,
    CatalogPhotoPage,
    CatalogStatusCounts,
    CatalogTaxonOption,
    CatalogTaxonPage,
)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _search_conditions(search: str) -> list:
    fields = (
        Photo.display_title,
        Photo.common_name,
        Photo.breed_guess,
        Photo.species_guess,
        Photo.category,
        Photo.description,
        Photo.original_filename,
        cast(Photo.tags, String),
        Animal.display_name,
        Animal.identifier,
        Animal.legacy_common_name,
        Animal.legacy_species_name,
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
    conditions = []
    for term in search.split():
        pattern = f"%{_escape_like(term.lower())}%"
        conditions.append(
            or_(
                *(
                    func.lower(func.coalesce(field, "")).like(
                        pattern,
                        escape="\\",
                    )
                    for field in fields
                )
            )
        )
    return conditions


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


def _catalog_facets(session: Session) -> CatalogFacets:
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
    sort: str,
    order: str,
) -> CatalogPhotoPage:
    joins_required = bool(search and search.strip()) or taxon_id is not None
    items_query = select(Photo).select_from(Photo)
    count_query = select(func.count(Photo.id)).select_from(Photo)
    if joins_required:
        items_query = items_query.outerjoin(
            Animal, Photo.animal_id == Animal.id
        ).outerjoin(
            Taxon,
            Animal.taxon_id == Taxon.id,
        )
        count_query = count_query.outerjoin(
            Animal,
            Photo.animal_id == Animal.id,
        ).outerjoin(Taxon, Animal.taxon_id == Taxon.id)

    conditions = [Photo.deleted_at.is_(None)]
    if search and search.strip():
        conditions.extend(_search_conditions(search.strip()))
    if status:
        conditions.append(Photo.status == status)
    if uncategorized:
        conditions.append(
            or_(Photo.category.is_(None), func.trim(Photo.category) == "")
        )
    elif category:
        conditions.append(Photo.category == category)
    if taxon_id is not None:
        conditions.append(Taxon.id == taxon_id)

    total = session.exec(count_query.where(*conditions)).one()
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
        facets=_catalog_facets(session),
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
    base = (
        select(
            Taxon.id,
            label.label("label"),
            Taxon.scientific_name,
            func.count(Photo.id).label("photo_count"),
        )
        .select_from(Taxon)
        .join(Animal, Animal.taxon_id == Taxon.id)
        .join(Photo, active_join)
        .group_by(Taxon.id, label, Taxon.scientific_name)
    )
    total = session.exec(
        select(func.count(func.distinct(Taxon.id)))
        .select_from(Taxon)
        .join(Animal, Animal.taxon_id == Taxon.id)
        .join(Photo, active_join)
    ).one()
    rows = session.exec(
        base.order_by(
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
