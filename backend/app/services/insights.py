"""SQLite aggregates only: no Photo hydration, image access or external services."""

from datetime import datetime

from sqlalchemy import Integer, and_, case, cast, func, or_
from sqlmodel import Session, select

from app.insights_schemas import (
    InsightsCamera,
    InsightsCoverage,
    InsightsDistribution,
    InsightsEquipment,
    InsightsLens,
    InsightsOverview,
    InsightsPeriod,
    InsightsResponse,
    InsightsSpecies,
)
from app.models import Animal, Photo, Taxon
from app.services.catalog import _gear_value
from app.services.metadata_health import capture_present, gps_present

CATEGORY_LIMIT = 20
STATUSES = {
    "pending": "Pending",
    "classified": "Classified",
    "needs_review": "Needs Review",
}


def percentage(count: int, total: int) -> float:
    return round(100 * count / total, 2) if total else 0.0


def get_insights(session: Session, year: int | None = None) -> InsightsResponse:
    if year is not None and not 1 <= year <= 9999:
        raise ValueError("year must be between 1 and 9999")
    conditions = [Photo.deleted_at.is_(None)]
    if year is not None:
        conditions.append(Photo.captured_at >= datetime(year, 1, 1))
        if year < 9999:
            conditions.append(Photo.captured_at < datetime(year + 1, 1, 1))
        else:
            conditions.append(Photo.captured_at <= datetime.max)

    # As in catalog counts, fetch wide rows by rowid for All Time. Traversing
    # the capture index then fetching every Photo/Animal scatters disk reads.
    # Selected years retain the selective existing capture index range scan.
    joined_conditions = (
        conditions
        if year is not None
        else [
            Photo.id.in_(
                select(Photo.id).where(Photo.deleted_at.is_(None)).correlate(None)
            )
        ]
    )

    # Linked local taxonomy is the same verification definition used by Albums.
    species = and_(Taxon.id.is_not(None), func.upper(Taxon.taxonomic_rank) == "SPECIES")
    gps = gps_present()
    uncategorized = func.trim(func.coalesce(Photo.category, "")) == ""
    # Share the Explorer/List contract: trim surrounding whitespace, preserve
    # case and spelling, and never infer a missing manufacturer or model.
    make = _gear_value(Photo.camera_make)
    model = _gear_value(Photo.camera_model)
    lens = _gear_value(Photo.lens_model)
    known_camera = or_(make != "", model != "")

    def count_if(condition):
        return func.count(case((condition, Photo.id)))

    row = session.exec(
        select(
            func.count(Photo.id),
            func.count(func.distinct(case((species, Taxon.id)))),
            count_if(Photo.is_favorite.is_(True)),
            count_if(Photo.culling_state == "pick"),
            count_if(Photo.culling_state == "reject"),
            count_if(gps),
            count_if(capture_present()),
            count_if(Taxon.id.is_(None)),
            count_if(and_(Taxon.id.is_not(None), ~species)),
            count_if(uncategorized),
            count_if(known_camera),
            count_if(lens != ""),
        )
        .select_from(Photo)
        .outerjoin(Animal, Photo.animal_id == Animal.id)
        .outerjoin(Taxon, Animal.taxon_id == Taxon.id)
        .where(*joined_conditions)
    ).one()
    (
        total,
        distinct,
        favorites,
        picks,
        rejects,
        gps_count,
        dated,
        unverified,
        other_rank,
        uncategorized_count,
        camera_count,
        lens_count,
    ) = row

    def coverage(known):
        return InsightsCoverage(
            known=known, missing=total - known, percentage=percentage(known, total)
        )

    # Substrings preserve camera-local time, without SQLite timezone conversion.
    capture_year = cast(func.substr(Photo.captured_at, 1, 4), Integer)
    capture_month = cast(func.substr(Photo.captured_at, 6, 2), Integer)
    # Global year options are deliberately independent of the selected year.
    year_rows = session.exec(
        select(capture_year, func.count(Photo.id))
        .where(Photo.deleted_at.is_(None), Photo.captured_at.is_not(None))
        .group_by(capture_year)
        .order_by(capture_year)
    ).all()
    monthly = []
    if year is not None:
        months = dict(
            session.exec(
                select(capture_month, func.count(Photo.id))
                .where(*conditions)
                .group_by(capture_month)
            ).all()
        )
        monthly = [
            InsightsPeriod(period=month, photo_count=months.get(month, 0))
            for month in range(1, 13)
        ]

    photo_count = func.count(Photo.id)
    # Two bounded grouped queries. Coverage piggybacks on the overview above;
    # neither ranking needs Photo ORM objects or an extra per-group lookup.
    camera_name = func.trim(make + " " + model)
    cameras = session.exec(
        select(make, model, photo_count)
        .where(*joined_conditions, known_camera)
        .group_by(make, model)
        .order_by(photo_count.desc(), camera_name.collate("NOCASE"), make, model)
        .limit(10)
    ).all()
    lenses = session.exec(
        select(lens, photo_count)
        .where(*joined_conditions, lens != "")
        .group_by(lens)
        .order_by(photo_count.desc(), lens.collate("NOCASE"), lens)
        .limit(10)
    ).all()
    ranked = session.exec(
        select(Taxon.id, Taxon.common_name, Taxon.scientific_name, photo_count)
        .select_from(Photo)
        .join(Animal, Photo.animal_id == Animal.id)
        .join(Taxon, Animal.taxon_id == Taxon.id)
        .where(*joined_conditions, species)
        .group_by(Taxon.id, Taxon.common_name, Taxon.scientific_name)
        .order_by(photo_count.desc(), Taxon.scientific_name.collate("NOCASE"), Taxon.id)
        .limit(10)
    ).all()

    def distribution(value, label, count, other=False):
        return InsightsDistribution(
            value=value,
            label=label,
            photo_count=count,
            percentage=percentage(count, total),
            other=other,
        )

    # Keep arbitrary user categories bounded, retaining an exact remainder total.
    category_rows = session.exec(
        select(Photo.category, photo_count)
        .where(*conditions, ~uncategorized)
        .group_by(Photo.category)
        .order_by(photo_count.desc(), Photo.category.collate("NOCASE"), Photo.category)
        .limit(CATEGORY_LIMIT)
    ).all()
    categories = [distribution(value, value, count) for value, count in category_rows]
    categories.append(distribution(None, "Uncategorized", uncategorized_count))
    remainder = total - uncategorized_count - sum(count for _, count in category_rows)
    if remainder:
        categories.append(distribution(None, "Other categories", remainder, other=True))

    # Group unexpected legacy statuses together so the totals still reconcile.
    status_key = case((Photo.status.in_(STATUSES), Photo.status), else_="other")
    statuses = dict(
        session.exec(
            select(status_key, photo_count).where(*conditions).group_by(status_key)
        ).all()
    )
    classification = [
        distribution(value, label, statuses.get(value, 0))
        for value, label in STATUSES.items()
    ]
    if statuses.get("other"):
        classification.append(
            distribution(None, "Other status", statuses["other"], other=True)
        )

    return InsightsResponse(
        year=year,
        overview=InsightsOverview(
            total_photos=total,
            verified_species=distinct,
            favorites=favorites,
            picks=picks,
            rejects=rejects,
            unverified_photos=unverified,
            other_taxon_rank_photos=other_rank,
            gps=coverage(gps_count),
            capture_dates=coverage(dated),
        ),
        available_years=[value for value, _ in year_rows],
        monthly=monthly,
        yearly=[
            InsightsPeriod(period=value, photo_count=count)
            for value, count in year_rows
            if year is None or year == value
        ],
        top_species=[
            InsightsSpecies(
                taxon_id=taxon_id,
                common_name=common,
                scientific_name=scientific,
                photo_count=count,
                percentage=percentage(count, total),
            )
            for taxon_id, common, scientific, count in ranked
        ],
        categories=categories,
        classification=classification,
        equipment=InsightsEquipment(
            camera=coverage(camera_count),
            lens=coverage(lens_count),
            top_cameras=[
                InsightsCamera(
                    camera_make=make or None,
                    camera_model=model or None,
                    photo_count=count,
                    percentage=percentage(count, total),
                )
                for make, model, count in cameras
            ],
            top_lenses=[
                InsightsLens(
                    lens_model=value,
                    photo_count=count,
                    percentage=percentage(count, total),
                )
                for value, count in lenses
            ],
        ),
    )
