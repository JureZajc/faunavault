"""Read-only projections of field observations for the Sightings Map."""

from itertools import batched

from sqlalchemy import func
from sqlmodel import Session, select

from app.models import Photo, Sighting, SightingPhoto, Taxon
from app.services.geography import bounding_box_condition
from app.services.metadata_health import gps_present
from app.services.sightings import observation_date_conditions
from app.sighting_schemas import SightingMapPoint, SightingMapQuery, SightingMapRead

MAP_POINT_LIMIT = 2000
THUMBNAIL_BATCH_SIZE = 500


def _thumbnails(session: Session, ids: list[int]) -> dict[int, str | None]:
    # Use the link table's (sighting_id, photo_id) key to find the first
    # eligible preview for each returned Sighting without loading Photo rows.
    preview = (
        select(Photo.thumbnail_filename)
        .select_from(SightingPhoto)
        .join(Photo, Photo.id == SightingPhoto.photo_id)
        .where(
            SightingPhoto.sighting_id == Sighting.id,
            Photo.deleted_at.is_(None),
            Photo.thumbnail_filename != "",
        )
        .order_by(SightingPhoto.photo_id)
        .limit(1)
        .correlate(Sighting)
        .scalar_subquery()
    )
    thumbnails = {}
    for batch in batched(ids, THUMBNAIL_BATCH_SIZE):
        thumbnails.update(
            (sighting_id, filename)
            for sighting_id, filename in session.exec(
                select(Sighting.id, preview).where(Sighting.id.in_(batch))
            )
        )
    return thumbnails


def list_map_points(session: Session, query: SightingMapQuery) -> SightingMapRead:
    filters = observation_date_conditions(query.date_from, query.date_to)
    if query.taxon_id is not None:
        filters.append(Sighting.taxon_id == query.taxon_id)

    located = gps_present(Sighting)
    in_area = located
    if query.bbox_south is not None:
        in_area = bounding_box_condition(
            query.bbox_south,
            query.bbox_north,
            query.bbox_west,
            query.bbox_east,
            model=Sighting,
        )
    mapped, unlocated = session.exec(
        select(
            func.count(Sighting.id).filter(in_area),
            func.count(Sighting.id).filter(~located),
        ).where(*filters)
    ).one()
    truncated = mapped > MAP_POINT_LIMIT
    point_query = (
        select(
            Sighting.id,
            Sighting.latitude,
            Sighting.longitude,
            Sighting.observed_at,
            Sighting.subject_label,
            Sighting.location_label,
            Sighting.taxon_id,
            Taxon.common_name,
            Taxon.scientific_name,
        )
        .outerjoin(Taxon, Taxon.id == Sighting.taxon_id)
        .where(*filters, in_area)
    )
    rows = (
        list(
            session.exec(
                point_query.order_by(
                    Sighting.observed_at.desc(), Sighting.id.desc()
                ).limit(MAP_POINT_LIMIT)
            )
        )
        if mapped
        else []
    )

    if (
        truncated
        and query.focus is not None
        and all(row.id != query.focus for row in rows)
    ):
        focused = session.exec(
            point_query.where(Sighting.id == query.focus)
        ).one_or_none()
        if focused is not None:
            rows[-1] = focused

    thumbnails = _thumbnails(session, [row.id for row in rows])
    return SightingMapRead(
        points=[
            SightingMapPoint(**row._mapping, thumbnail_filename=thumbnails[row.id])
            for row in rows
        ],
        total_matching=mapped + unlocated,
        without_location_count=unlocated,
        truncated=truncated,
    )
