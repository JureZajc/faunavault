from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, or_, tuple_
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import aliased
from sqlmodel import Session, select

from app.models import DuplicatePair, DuplicateScanState, Photo, utc_now
from app.schemas import (
    DuplicateComparison,
    DuplicateDismissRequest,
    DuplicateDismissResponse,
    DuplicateIdentity,
    DuplicateReview,
    DuplicateSummary,
)
from app.services.perceptual_duplicates import (
    PHASH_ALGORITHM,
    PHASH_DISTANCE_THRESHOLD,
    hamming_distance,
    is_valid_perceptual_hash,
)

DETECTOR = f"{PHASH_ALGORITHM}:d{PHASH_DISTANCE_THRESHOLD}"
ORDER = (
    DuplicatePair.distance,
    DuplicatePair.left_photo_id,
    DuplicatePair.right_photo_id,
)


def pair_values(
    left: Photo, right: Photo, *, now: datetime | None = None
) -> dict | None:
    if left.id == right.id:
        return None
    if left.id > right.id:
        left, right = right, left
    if not all(is_valid_perceptual_hash(p.perceptual_hash) for p in (left, right)):
        return None
    if left.content_sha256 is not None and left.content_sha256 == right.content_sha256:
        return None
    distance = hamming_distance(left.perceptual_hash, right.perceptual_hash)
    if distance > PHASH_DISTANCE_THRESHOLD:
        return None
    return dict(
        left_photo_id=left.id,
        right_photo_id=right.id,
        detector=DETECTOR,
        left_hash=left.perceptual_hash,
        right_hash=right.perceptual_hash,
        distance=distance,
        discovered_at=now or utc_now(),
        dismissed_at=None,
    )


def upsert_pairs(connection, values: list[dict]) -> None:
    """Preserve human decisions unless the evidence actually changes."""
    if not values:
        return
    statement = insert(DuplicatePair)
    excluded = statement.excluded
    statement = statement.on_conflict_do_update(
        index_elements=["left_photo_id", "right_photo_id", "detector"],
        set_={
            name: getattr(excluded, name)
            for name in (
                "left_hash",
                "right_hash",
                "distance",
                "discovered_at",
                "dismissed_at",
            )
        },
        where=or_(
            DuplicatePair.left_hash != excluded.left_hash,
            DuplicatePair.right_hash != excluded.right_hash,
            DuplicatePair.distance != excluded.distance,
        ),
    )
    connection.execute(statement, values)


def record_ingestion_pairs(
    session: Session, photo: Photo, candidate_ids: list[int], reviewed_ids: list[int]
) -> None:
    for photo_id in dict.fromkeys([*candidate_ids, *reviewed_ids]):
        other = session.get(Photo, photo_id)
        if other is None:
            continue  # A permanently deleted displayed candidate has no pair to retain.
        values = pair_values(photo, other)
        if values is None:
            if photo_id in reviewed_ids:
                raise HTTPException(
                    409,
                    detail="Displayed duplicate evidence changed; retry upload review.",
                )
            continue
        upsert_pairs(session.connection(), [values])
        if photo_id in reviewed_ids:
            pair = session.get(
                DuplicatePair,
                (values["left_photo_id"], values["right_photo_id"], DETECTOR),
            )
            pair.dismissed_at = pair.dismissed_at or utc_now()
            session.add(pair)


def _query(*, dismissed: bool = False, active: bool = True):
    left, right = aliased(Photo), aliased(Photo)
    query = (
        select(DuplicatePair)
        .join(left, left.id == DuplicatePair.left_photo_id)
        .join(right, right.id == DuplicatePair.right_photo_id)
        .where(
            DuplicatePair.detector == DETECTOR,
            DuplicatePair.left_hash == left.perceptual_hash,
            DuplicatePair.right_hash == right.perceptual_hash,
            DuplicatePair.distance <= PHASH_DISTANCE_THRESHOLD,
            or_(
                left.content_sha256.is_(None),
                right.content_sha256.is_(None),
                left.content_sha256 != right.content_sha256,
            ),
            DuplicatePair.dismissed_at.is_not(None)
            if dismissed
            else DuplicatePair.dismissed_at.is_(None),
        )
    )
    if active:
        query = query.where(left.deleted_at.is_(None), right.deleted_at.is_(None))
    return query


def _count(session: Session, query) -> int:
    return session.exec(select(func.count()).select_from(query.subquery())).one()


def identity(pair: DuplicatePair | None) -> DuplicateIdentity | None:
    return (
        None
        if pair is None
        else DuplicateIdentity(left=pair.left_photo_id, right=pair.right_photo_id)
    )


def summary(session: Session) -> DuplicateSummary:
    return DuplicateSummary(
        unresolved=_count(session, _query()),
        dismissed=_count(session, _query(dismissed=True, active=False)),
        detector=DETECTOR,
        threshold=PHASH_DISTANCE_THRESHOLD,
        scan=session.get(DuplicateScanState, DETECTOR),
        missing_fingerprints=session.exec(
            select(func.count())
            .select_from(Photo)
            .where(Photo.perceptual_hash.is_(None))
        ).one(),
    )


def review(
    session: Session, left: int | None = None, right: int | None = None
) -> DuplicateReview:
    query = _query()
    total = _count(session, query)
    first = session.exec(query.order_by(*ORDER).limit(1)).first()
    requested = left is not None and right is not None
    pair = (
        session.exec(
            query.where(
                DuplicatePair.left_photo_id == left,
                DuplicatePair.right_photo_id == right,
            ).limit(1)
        ).first()
        if requested
        else first
    )
    unavailable = requested and pair is None
    pair = pair or first
    if pair is None:
        return DuplicateReview(
            pair=None, total=total, requested_pair_unavailable=unavailable
        )
    key = (pair.distance, pair.left_photo_id, pair.right_photo_id)
    previous = session.exec(
        query.where(tuple_(*ORDER) < key)
        .order_by(*(column.desc() for column in ORDER))
        .limit(1)
    ).first()
    following = session.exec(
        query.where(tuple_(*ORDER) > key).order_by(*ORDER).limit(1)
    ).first()
    return DuplicateReview(
        pair=DuplicateComparison(
            identity=identity(pair),
            left_photo=session.get(Photo, pair.left_photo_id),
            right_photo=session.get(Photo, pair.right_photo_id),
            detector=pair.detector,
            distance=pair.distance,
            discovered_at=pair.discovered_at,
        ),
        total=total,
        previous=identity(previous),
        next=identity(following),
        first=identity(first),
        requested_pair_unavailable=unavailable,
    )


def dismiss(
    session: Session, left: int, right: int, request: DuplicateDismissRequest
) -> DuplicateDismissResponse:
    # Serialize the active/evidence checks and decision against lifecycle writes.
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    pair = session.get(DuplicatePair, (left, right, DETECTOR))
    if pair is None:
        raise HTTPException(404, detail="Duplicate pair not found")
    eligible = session.exec(
        _query(dismissed=pair.dismissed_at is not None).where(
            DuplicatePair.left_photo_id == left, DuplicatePair.right_photo_id == right
        )
    ).first()
    if (
        eligible is None
        or request.detector != DETECTOR
        or request.expected_discovered_at.replace(tzinfo=None)
        != pair.discovered_at.replace(tzinfo=None)
    ):
        raise HTTPException(
            409,
            detail="Duplicate pair changed or is no longer active; refresh the review.",
        )
    pair.dismissed_at = pair.dismissed_at or utc_now()
    session.add(pair)
    session.flush()
    query = _query()
    following = session.exec(
        query.where(tuple_(*ORDER) > (pair.distance, left, right))
        .order_by(*ORDER)
        .limit(1)
    ).first()
    following = following or session.exec(query.order_by(*ORDER).limit(1)).first()
    remaining = _count(session, query)
    session.commit()
    return DuplicateDismissResponse(
        identity=identity(pair),
        dismissed_at=pair.dismissed_at,
        remaining=remaining,
        next=identity(following),
    )
