"""Effective capture metadata predicates and a single SQLite health aggregate."""

from sqlalchemy import and_, case, func, or_
from sqlmodel import Session, select

from app.catalog_query import MetadataIssue
from app.models import Photo
from app.schemas import MetadataHealth


def capture_present():
    return Photo.captured_at.is_not(None)


def gps_present():
    # Explicit presence makes negation two-valued even for partial legacy pairs.
    return and_(
        Photo.latitude.is_not(None),
        Photo.longitude.is_not(None),
        Photo.latitude.between(-90, 90),
        Photo.longitude.between(-180, 180),
    )


def metadata_condition(issue: MetadataIssue):
    capture, gps = capture_present(), gps_present()
    return {
        "missing_capture": ~capture,
        "missing_gps": ~gps,
        "missing_both": and_(~capture, ~gps),
        "missing_either": or_(~capture, ~gps),
        "complete": and_(capture, gps),
    }[issue]


def get_metadata_health(session: Session) -> MetadataHealth:
    total, missing_capture, missing_gps, missing_both, complete = session.exec(
        select(
            func.count(Photo.id),
            *(
                func.count(case((metadata_condition(issue), 1)))
                for issue in (
                    "missing_capture",
                    "missing_gps",
                    "missing_both",
                    "complete",
                )
            ),
        ).where(Photo.deleted_at.is_(None))
    ).one()
    return MetadataHealth(
        active_total=total,
        missing_capture=missing_capture,
        missing_gps=missing_gps,
        missing_both=missing_both,
        missing_either=total - complete,
        complete=complete,
        completeness_percentage=round(100 * complete / total, 2) if total else 0.0,
    )
