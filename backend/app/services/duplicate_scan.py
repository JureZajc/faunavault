from __future__ import annotations

import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass

from sqlalchemy.dialects.sqlite import insert

from app.archive_integrity import inspect_database
from app.config import Settings
from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION
from app.models import DuplicateScanState, utc_now
from app.services.archive_maintenance import (
    MaintenanceSetupError,
    lifecycle_problem,
    resolve_storage,
)
from app.services.duplicate_review import DETECTOR, pair_values, upsert_pairs
from app.services.perceptual_duplicates import (
    VisualDuplicateIndex,
    VisualIndexEntry,
    is_valid_perceptual_hash,
)

MAX_PROBES = 50_000_000
MAX_PAIRS = 1_000_000
BATCH_SIZE = 500


class ScanStopped(RuntimeError):
    pass


@dataclass(frozen=True)
class FingerprintPhoto:
    id: int
    perceptual_hash: str | None
    content_sha256: str | None


@dataclass
class ScanResult:
    applied: bool
    processed: int = 0
    skipped: int = 0
    pairs: int = 0
    probes: int = 0
    complete: bool = False
    reason: str | None = None
    seconds: float = 0
    exact_groups: int = 0


@contextmanager
def _scan_connection(settings: Settings):
    engine = create_database_engine(settings)
    try:
        with engine.connect() as connection:
            yield connection
    finally:
        engine.dispose()


def scan_duplicates(
    settings: Settings,
    *,
    apply: bool = False,
    max_probes: int = MAX_PROBES,
    max_pairs: int = MAX_PAIRS,
    progress: Callable[[int, int], None] | None = None,
    exact_collision: Callable[[tuple[int, ...]], None] | None = None,
) -> ScanResult:
    if min(max_probes, max_pairs) < 1:
        raise MaintenanceSetupError("Scan limits must be positive")
    storage = resolve_storage(settings)
    if problem := lifecycle_problem(settings):
        raise MaintenanceSetupError(problem)
    from app.archive_integrity import ArchiveIntegrityError

    try:
        inspect_database(storage.database, LATEST_SCHEMA_VERSION)
    except ArchiveIntegrityError as exc:
        raise MaintenanceSetupError(str(exc)) from exc
    result = ScanResult(applied=apply)
    started = time.monotonic()
    pending: list[dict] = []
    index = VisualDuplicateIndex()
    with _scan_connection(settings) as connection:
        baseline = None
        try:
            if apply:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            baseline = connection.exec_driver_sql("PRAGMA data_version").scalar_one()
            rows = [
                FingerprintPhoto(*row)
                for row in connection.exec_driver_sql(
                    "SELECT id, perceptual_hash, content_sha256 FROM photo ORDER BY id"
                )
            ]
            prior = (
                connection.execute(
                    DuplicateScanState.__table__.select().where(
                        DuplicateScanState.detector == DETECTOR
                    )
                )
                .mappings()
                .first()
            )
            state = dict(
                detector=DETECTOR,
                status="incomplete",
                started_at=utc_now(),
                completed_at=None,
                last_successful_at=prior["last_successful_at"] if prior else None,
                processed=0,
                skipped=0,
                pairs=0,
                probes=0,
                reason="Scan interrupted before completion",
            )
            if apply:
                statement = insert(DuplicateScanState).values(**state)
                connection.execute(
                    statement.on_conflict_do_update(
                        index_elements=["detector"], set_=state
                    )
                )
            connection.commit()
            by_id = {row.id: row for row in rows}
            digests: dict[str, list[int]] = {}
            for row in rows:
                if row.content_sha256 is not None:
                    digests.setdefault(row.content_sha256, []).append(row.id)
            for ids in digests.values():
                if len(ids) > 1:
                    result.exact_groups += 1
                    if exact_collision:
                        exact_collision(tuple(ids))

            def consistent() -> None:
                if (
                    connection.exec_driver_sql("PRAGMA data_version").scalar_one()
                    != baseline
                ):
                    raise ScanStopped(
                        "Database changed externally; keep backend and importer stopped, then rerun"
                    )

            def flush() -> None:
                if apply:
                    connection.exec_driver_sql("BEGIN IMMEDIATE")
                consistent()
                if apply:
                    upsert_pairs(connection, pending)
                    connection.execute(
                        DuplicateScanState.__table__.update()
                        .where(DuplicateScanState.detector == DETECTOR)
                        .values(
                            processed=result.processed,
                            skipped=result.skipped,
                            pairs=result.pairs,
                            probes=result.probes,
                        )
                    )
                connection.commit()
                pending.clear()

            def visit() -> None:
                if result.probes >= max_probes:
                    raise ScanStopped(
                        f"Bucket probe limit reached ({max_probes}); raise --max-probes and rerun"
                    )
                result.probes += 1

            for row in rows:
                if not is_valid_perceptual_hash(row.perceptual_hash):
                    result.skipped += 1
                else:
                    for other, _distance in index.iter_matches(
                        row.perceptual_hash, visit=visit
                    ):
                        values = pair_values(by_id[other.photo_id], row)
                        if values is None:
                            continue
                        if result.pairs >= max_pairs:
                            raise ScanStopped(
                                f"Pair limit reached ({max_pairs}); raise --max-pairs and rerun"
                            )
                        result.pairs += 1
                        pending.append(values)
                        if len(pending) >= BATCH_SIZE:
                            flush()
                    index.add(VisualIndexEntry(row.id, row.perceptual_hash, ""))
                result.processed += 1
                if result.processed % BATCH_SIZE == 0:
                    flush()
                    if progress:
                        progress(result.processed, len(rows))
            flush()
            if apply:
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            consistent()
            if apply:
                now = utc_now()
                connection.execute(
                    DuplicateScanState.__table__.update()
                    .where(DuplicateScanState.detector == DETECTOR)
                    .values(
                        status="complete",
                        completed_at=now,
                        last_successful_at=now,
                        reason=None,
                    )
                )
            connection.commit()
            result.complete = True
            if progress:
                progress(result.processed, len(rows))
        except (ScanStopped, KeyboardInterrupt) as exc:
            connection.rollback()
            result.complete = False
            result.reason = str(exc) or "Scan interrupted"
            if baseline is None:
                return result
            # Flush only when the archive remains unchanged; never claim completion.
            if (
                connection.exec_driver_sql("PRAGMA data_version").scalar_one()
                == baseline
                and apply
            ):
                connection.commit()
                connection.exec_driver_sql("BEGIN IMMEDIATE")
                if (
                    connection.exec_driver_sql("PRAGMA data_version").scalar_one()
                    == baseline
                ):
                    upsert_pairs(connection, pending)
                connection.execute(
                    DuplicateScanState.__table__.update()
                    .where(DuplicateScanState.detector == DETECTOR)
                    .values(
                        status="incomplete",
                        reason=result.reason,
                        processed=result.processed,
                        skipped=result.skipped,
                        pairs=result.pairs,
                        probes=result.probes,
                    )
                )
                connection.commit()
            elif apply:
                connection.execute(
                    DuplicateScanState.__table__.update()
                    .where(DuplicateScanState.detector == DETECTOR)
                    .values(status="incomplete", reason=result.reason)
                )
                connection.commit()
        finally:
            result.seconds = time.monotonic() - started
    return result
