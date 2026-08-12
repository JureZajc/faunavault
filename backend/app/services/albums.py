from __future__ import annotations

import logging

from sqlalchemy import (
    String,
    and_,
    case,
    cast,
    exists,
    false,
    func,
    literal,
    or_,
    union_all,
    update,
)
from sqlalchemy.orm import aliased
from sqlmodel import Session, select

from app.album_identity import (
    AlbumIdentity,
    legacy_album_key_from_group,
    taxon_album_key,
)
from app.clients.gbif import GbifClient
from app.models import Animal, Photo, Taxon, utc_now
from app.services.taxonomy import (
    legacy_taxonomy_groups_query,
    persist_taxon_selection,
    prepare_taxon_selection,
    taxon_to_candidate,
)

logger = logging.getLogger(__name__)


class AlbumNotFoundError(Exception):
    pass


class AlbumAlreadyVerifiedError(Exception):
    pass


def _photo_stats():
    return (
        select(
            Photo.animal_id.label("animal_id"),
            func.count(Photo.id).label("photo_count"),
            func.max(Photo.created_at).label("photo_newest"),
        )
        .where(Photo.deleted_at.is_(None), Photo.animal_id.is_not(None))
        .group_by(Photo.animal_id)
        .cte("active_photo_by_animal")
    )


def _newest_expression(animal_newest, photo_newest):
    return case(
        (photo_newest.is_(None), animal_newest),
        (photo_newest > animal_newest, photo_newest),
        else_=animal_newest,
    )


def _album_groups(identity: AlbumIdentity | None = None):
    photos = _photo_stats()
    animal_newest = func.max(Animal.created_at)
    photo_newest = func.max(photos.c.photo_newest)
    newest = _newest_expression(animal_newest, photo_newest)

    verified_condition = literal(True)
    legacy_condition = literal(True)
    if identity is not None:
        if identity.kind == "taxon":
            verified_condition = Taxon.id == identity.taxon_id
            legacy_condition = false()
        else:
            verified_condition = false()
            legacy_condition = Animal.legacy_species_group == identity.legacy_group

    verified = (
        select(
            literal("taxon").label("kind"),
            Taxon.id.label("taxon_id"),
            cast(literal(None), String).label("legacy_group"),
            func.min(Animal.id).label("representative_id"),
            literal(True).label("verified"),
            Taxon.common_name.label("common_name"),
            Taxon.canonical_name.label("scientific_name"),
            Taxon.taxonomic_rank.label("rank"),
            Taxon.taxonomic_class.label("class_name"),
            Taxon.taxonomic_order.label("order_name"),
            Taxon.family.label("family"),
            Taxon.genus.label("genus"),
            Taxon.species.label("species"),
            func.count(Animal.id).label("animal_count"),
            func.coalesce(func.sum(photos.c.photo_count), 0).label("photo_count"),
            newest.label("newest_at"),
        )
        .select_from(Animal)
        .join(Taxon, Animal.taxon_id == Taxon.id)
        .outerjoin(photos, photos.c.animal_id == Animal.id)
        .where(verified_condition)
        .group_by(
            Taxon.id,
            Taxon.common_name,
            Taxon.canonical_name,
            Taxon.taxonomic_rank,
            Taxon.taxonomic_class,
            Taxon.taxonomic_order,
            Taxon.family,
            Taxon.genus,
            Taxon.species,
        )
    )

    legacy_core = (
        select(
            Animal.legacy_species_group.label("legacy_group"),
            func.min(Animal.id).label("representative_id"),
            func.count(Animal.id).label("animal_count"),
            func.coalesce(func.sum(photos.c.photo_count), 0).label("photo_count"),
            newest.label("newest_at"),
        )
        .select_from(Animal)
        .outerjoin(Taxon, Animal.taxon_id == Taxon.id)
        .outerjoin(photos, photos.c.animal_id == Animal.id)
        .where(Taxon.id.is_(None), legacy_condition)
        .group_by(Animal.legacy_species_group)
        .subquery("legacy_album_core")
    )
    representative = aliased(Animal)
    legacy_name = case(
        (
            or_(
                representative.legacy_species_name.is_(None),
                representative.legacy_species_name == "",
            ),
            "Unidentified",
        ),
        else_=representative.legacy_species_name,
    )
    legacy = (
        select(
            literal("legacy").label("kind"),
            cast(literal(None), Taxon.id.type).label("taxon_id"),
            legacy_core.c.legacy_group,
            legacy_core.c.representative_id,
            literal(False).label("verified"),
            cast(literal(None), String).label("common_name"),
            legacy_name.label("scientific_name"),
            cast(literal(None), String).label("rank"),
            cast(literal(None), String).label("class_name"),
            cast(literal(None), String).label("order_name"),
            cast(literal(None), String).label("family"),
            cast(literal(None), String).label("genus"),
            legacy_name.label("species"),
            legacy_core.c.animal_count,
            legacy_core.c.photo_count,
            legacy_core.c.newest_at,
        )
        .select_from(legacy_core)
        .join(representative, representative.id == legacy_core.c.representative_id)
    )
    return union_all(verified, legacy).subquery("album_groups")


def _identity_tuple(row) -> tuple[str, int | None, str | None]:
    return row.kind, row.taxon_id, row.legacy_group


def _album_key(row) -> str:
    if row.kind == "taxon":
        return taxon_album_key(row.taxon_id)
    return legacy_album_key_from_group(row.legacy_group)


def _summary(row, cover: tuple[int, str] | None = None) -> dict:
    return {
        "album_key": _album_key(row),
        "verified": bool(row.verified),
        "common_name": row.common_name,
        "scientific_name": row.scientific_name,
        "rank": row.rank,
        "class": row.class_name,
        "order": row.order_name,
        "family": row.family,
        "genus": row.genus,
        "species": row.species,
        "animal_count": row.animal_count,
        "photo_count": row.photo_count,
        "newest_at": row.newest_at,
        "cover_photo_id": cover[0] if cover else None,
        "cover_thumbnail_filename": cover[1] if cover else None,
    }


def _cover_map(session: Session, rows: list) -> dict:
    if not rows:
        return {}
    taxon_ids = [row.taxon_id for row in rows if row.kind == "taxon"]
    legacy_groups = [row.legacy_group for row in rows if row.kind == "legacy"]
    conditions = []
    if taxon_ids:
        conditions.append(Taxon.id.in_(taxon_ids))
    if legacy_groups:
        conditions.append(
            and_(Taxon.id.is_(None), Animal.legacy_species_group.in_(legacy_groups))
        )
    cover_legacy_group = case(
        (Taxon.id.is_(None), Animal.legacy_species_group),
        else_=None,
    )
    ranked = (
        select(
            case((Taxon.id.is_not(None), "taxon"), else_="legacy").label("kind"),
            Taxon.id.label("taxon_id"),
            cover_legacy_group.label("legacy_group"),
            Photo.id.label("photo_id"),
            Photo.thumbnail_filename.label("thumbnail_filename"),
            func.row_number()
            .over(
                partition_by=(Taxon.id, cover_legacy_group),
                order_by=(Photo.created_at.desc(), Photo.id.desc()),
            )
            .label("position"),
        )
        .select_from(Photo)
        .join(Animal, Photo.animal_id == Animal.id)
        .outerjoin(Taxon, Animal.taxon_id == Taxon.id)
        .where(Photo.deleted_at.is_(None), or_(*conditions))
        .subquery("ranked_album_covers")
    )
    covers = (
        session.execute(select(ranked).where(ranked.c.position == 1)).mappings().all()
    )
    return {
        (row.kind, row.taxon_id, row.legacy_group): (
            row.photo_id,
            row.thumbnail_filename,
        )
        for row in covers
    }


def list_albums(
    session: Session,
    *,
    page: int,
    page_size: int,
    query: str,
    taxonomic_class: str | None,
    order: str | None,
    family: str | None,
    genus: str | None,
    species: str | None,
    only_with_photos: bool,
    sort: str,
) -> dict:
    groups = _album_groups()
    conditions = []
    normalized_query = query.strip().lower()
    if normalized_query:
        searchable = (
            func.coalesce(groups.c.common_name, "")
            + " "
            + func.coalesce(groups.c.scientific_name, "")
            + " "
            + func.coalesce(groups.c.class_name, "")
            + " "
            + func.coalesce(groups.c.order_name, "")
            + " "
            + func.coalesce(groups.c.family, "")
            + " "
            + func.coalesce(groups.c.genus, "")
        )
        conditions.append(
            func.instr(func.faunavault_unicode_lower(searchable), normalized_query) > 0
        )
    for column, value in (
        (groups.c.class_name, taxonomic_class),
        (groups.c.order_name, order),
        (groups.c.family, family),
        (groups.c.genus, genus),
        (groups.c.species, species),
    ):
        if value:
            conditions.append(column == value)
    if only_with_photos:
        conditions.append(groups.c.photo_count > 0)

    filtered = select(groups).where(*conditions).subquery("filtered_albums")
    total = session.exec(select(func.count()).select_from(filtered)).one()
    identity_order = (
        filtered.c.kind.asc(),
        filtered.c.taxon_id.asc(),
        filtered.c.legacy_group.asc(),
    )
    display_name = func.coalesce(
        func.nullif(func.trim(filtered.c.common_name), ""),
        filtered.c.scientific_name,
    )
    if sort == "name":
        ordering = (func.faunavault_unicode_lower(display_name).asc(), *identity_order)
    elif sort == "newest":
        ordering = (filtered.c.newest_at.desc(), *identity_order)
    else:
        ordering = (
            getattr(filtered.c, sort).desc(),
            func.faunavault_unicode_lower(filtered.c.scientific_name).desc(),
            *identity_order,
        )
    rows = list(
        session.execute(
            select(filtered)
            .order_by(*ordering)
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        .mappings()
        .all()
    )
    covers = _cover_map(session, rows)
    return {
        "items": [_summary(row, covers.get(_identity_tuple(row))) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def taxonomy_filters(session: Session) -> dict:
    result = {}
    field_map = {
        "classes": Taxon.taxonomic_class,
        "orders": Taxon.taxonomic_order,
        "families": Taxon.family,
        "genera": Taxon.genus,
        "species": Taxon.species,
    }
    legacy = legacy_taxonomy_groups_query()
    for output_name, field in field_map.items():
        verified = (
            select(field.label("value"), func.count(Animal.id).label("count"))
            .select_from(Animal)
            .join(Taxon, Animal.taxon_id == Taxon.id)
            .where(field.is_not(None), field != "")
            .group_by(field)
        )
        if output_name == "species":
            legacy_species = select(
                legacy.c.legacy_name.label("value"),
                legacy.c.animal_count.label("count"),
            ).where(legacy.c.legacy_name != "")
            values = union_all(verified, legacy_species).subquery("filter_values")
            query = (
                select(values.c.value, func.sum(values.c.count).label("count"))
                .group_by(values.c.value)
                .order_by(func.faunavault_unicode_lower(values.c.value), values.c.value)
            )
        else:
            query = verified.order_by(func.faunavault_unicode_lower(field), field)
        result[output_name] = [
            {"value": value, "count": count}
            for value, count in session.exec(query).all()
        ]
    return result


def _animal_conditions(identity: AlbumIdentity):
    if identity.kind == "taxon":
        return [Taxon.id == identity.taxon_id]
    return [Taxon.id.is_(None), Animal.legacy_species_group == identity.legacy_group]


def get_album_detail(
    session: Session,
    identity: AlbumIdentity,
    *,
    animal_page: int,
    animal_page_size: int,
    photo_page: int,
    photo_page_size: int,
) -> dict:
    groups = _album_groups(identity)
    row = session.execute(select(groups)).mappings().first()
    if row is None:
        raise AlbumNotFoundError
    covers = _cover_map(session, [row])
    summary = _summary(row, covers.get(_identity_tuple(row)))

    animal_query = select(Animal).outerjoin(Taxon, Animal.taxon_id == Taxon.id)
    animal_query = animal_query.where(*_animal_conditions(identity)).order_by(
        Animal.identifier, Animal.id
    )
    animals = list(
        session.exec(
            animal_query.offset((animal_page - 1) * animal_page_size).limit(
                animal_page_size
            )
        ).all()
    )
    photo_query = (
        select(Photo)
        .select_from(Photo)
        .join(Animal, Photo.animal_id == Animal.id)
        .outerjoin(Taxon, Animal.taxon_id == Taxon.id)
        .where(Photo.deleted_at.is_(None), *_animal_conditions(identity))
        .order_by(Photo.created_at.desc(), Photo.id.desc())
    )
    photos = list(
        session.exec(
            photo_query.offset((photo_page - 1) * photo_page_size).limit(
                photo_page_size
            )
        ).all()
    )
    taxon = session.get(Taxon, identity.taxon_id) if identity.kind == "taxon" else None
    return {
        **summary,
        "taxonomy": taxon_to_candidate(taxon) if taxon else None,
        "animals": {
            "items": animals,
            "total": summary["animal_count"],
            "page": animal_page,
            "page_size": animal_page_size,
        },
        "photos": {
            "items": photos,
            "total": summary["photo_count"],
            "page": photo_page,
            "page_size": photo_page_size,
        },
    }


def _unverified_group_condition(legacy_group: str):
    matching_taxon = exists(select(Taxon.id).where(Taxon.id == Animal.taxon_id))
    return and_(
        ~matching_taxon,
        Animal.legacy_species_group == legacy_group,
    )


def assign_album_taxon(
    session: Session,
    identity: AlbumIdentity,
    gbif_key: int,
    client: GbifClient,
) -> dict:
    groups = _album_groups(identity)
    row = session.execute(select(groups)).mappings().first()
    if row is None:
        raise AlbumNotFoundError
    if identity.kind == "taxon":
        raise AlbumAlreadyVerifiedError
    expected_count = row.animal_count
    try:
        selection = prepare_taxon_selection(session, client, gbif_key)
        with session.begin():
            current = (
                session.execute(select(_album_groups(identity))).mappings().first()
            )
            if current is None or current.animal_count != expected_count:
                raise RuntimeError(
                    "Album membership changed during taxonomy assignment"
                )
            taxon = persist_taxon_selection(session, selection)
            now = utc_now()
            result = session.execute(
                update(Animal)
                .where(_unverified_group_condition(identity.legacy_group or ""))
                .values(
                    taxon_id=taxon.id,
                    taxonomy_status="manually_linked",
                    taxonomy_note=None,
                    updated_at=now,
                )
            )
            updated = result.rowcount
            if updated != expected_count:
                raise RuntimeError(
                    "Album membership changed during taxonomy assignment"
                )
            response = {
                "album_key": taxon_album_key(taxon.id or 0),
                "updated_animals": updated,
                "taxon": taxon_to_candidate(taxon),
            }
    except Exception:
        session.rollback()
        logger.exception(
            "Album taxonomy assignment album_key=%s gbif_key=%s failed",
            _album_key(row),
            gbif_key,
        )
        raise
    return response
