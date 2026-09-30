from __future__ import annotations

import random
import sqlite3
from datetime import timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, select

from app.archive_integrity import inspect_database, read_duplicate_signature
from app.config import Settings
from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION, run_migrations
from app.models import DuplicatePair, DuplicateScanState, Photo, utc_now
from app.schemas import DuplicateDismissRequest
from app.services.duplicate_review import (
    DETECTOR,
    dismiss,
    review,
    summary,
)
from app.services.duplicate_scan import scan_duplicates
from app.services.perceptual_duplicates import (
    VisualDuplicateIndex,
    VisualIndexEntry,
    hamming_distance,
)
from app.services.photo_lifecycle import mark_photos_trashed, restore_photo
from app.storage_startup import initialize_archive_storage
from tests import test_perceptual_duplicates as existing_duplicates
from tests.test_perceptual_duplicates import (  # noqa: F401
    encoded,
    post_image,
    scene,
)


@pytest.fixture()
def duplicate_lifecycle(tmp_path, monkeypatch):
    yield from existing_duplicates.perceptual_lifecycle.__wrapped__(
        tmp_path, monkeypatch
    )


@pytest.fixture()
def scan_archive(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{tmp_path / 'data' / 'archive.db'}",
    )
    engine = create_database_engine(settings)
    initialize_archive_storage(engine, settings)
    yield engine, settings
    engine.dispose()


def seed(engine, hashes):
    with Session(engine) as session:
        photos = []
        for i, value in enumerate(hashes, 1):
            photo = Photo(
                original_filename=f"{i}.jpg",
                stored_filename=f"{i}.jpg",
                resized_filename=f"{i}-resized.jpg",
                thumbnail_filename=f"{i}-thumb.jpg",
                perceptual_hash=value,
                content_sha256=f"{i:064x}",
            )
            session.add(photo)
            photos.append(photo)
        session.commit()
        return [photo.id for photo in photos]


def decisions(session):
    return session.exec(
        select(DuplicatePair).order_by(
            DuplicatePair.left_photo_id, DuplicatePair.right_photo_id
        )
    ).all()


def dismiss_request(pair):
    return DuplicateDismissRequest(
        detector=pair.detector, expected_discovered_at=pair.discovered_at
    )


def test_scan_exact_threshold_chain_canonical_and_order(scan_archive):
    engine, settings = scan_archive
    seed(
        engine,
        [
            "0000000000000000",
            "000000000000000f",
            "00000000000000ff",
            "ffffffffffffffff",
            None,
        ],
    )
    originals = settings.image_dirs["original"] / "sentinel.jpg"
    originals.write_bytes(b"original bytes are never decoded or changed")
    before = originals.read_bytes(), originals.stat().st_mtime_ns
    result = scan_duplicates(settings, apply=True)
    assert result.complete and result.pairs == 2 and result.skipped == 1
    with Session(engine) as session:
        pairs = decisions(session)
        assert [(p.left_photo_id, p.right_photo_id, p.distance) for p in pairs] == [
            (1, 2, 4),
            (2, 3, 4),
        ]
        first = review(session)
        assert (
            first.total == 2 and first.pair.identity.left == 1 and first.next.left == 2
        )
        following = review(session, 2, 3)
        assert following.previous == first.pair.identity and following.next is None
        assert following.total == 2  # Retrieving/skipping never writes a decision.
        assert summary(session).missing_fingerprints == 1
        assert session.get(DuplicateScanState, DETECTOR).status == "complete"
    assert (originals.read_bytes(), originals.stat().st_mtime_ns) == before


def test_dry_run_idempotency_dismissal_restart_and_changed_evidence(scan_archive):
    engine, settings = scan_archive
    seed(engine, ["0000000000000000", "0000000000000001"])
    before = settings.database_path.read_bytes()
    assert scan_duplicates(settings).pairs == 1
    assert settings.database_path.read_bytes() == before
    with Session(engine) as session:
        assert (
            decisions(session) == []
            and session.get(DuplicateScanState, DETECTOR) is None
        )
    scan_duplicates(settings, apply=True)
    with Session(engine) as session:
        pair = decisions(session)[0]
        discovered = pair.discovered_at
        request = dismiss_request(pair)
        first = dismiss(session, 1, 2, request)
        second = dismiss(session, 1, 2, request)
        assert first.dismissed_at == second.dismissed_at and first.remaining == 0
        assert session.get(Photo, 1).reviewed_at is None
    signature = read_duplicate_signature(settings.database_path)[0]
    scan_duplicates(settings, apply=True)
    with Session(engine) as session:
        assert summary(session).dismissed == 1 and review(session).pair is None
        assert decisions(session)[0].discovered_at == discovered
        assert read_duplicate_signature(settings.database_path)[0] == signature
        photo = session.get(Photo, 2)
        photo.perceptual_hash = "0000000000000003"
        session.add(photo)
        session.commit()
        assert summary(session).dismissed == 0
    scan_duplicates(settings, apply=True)
    with Session(engine) as session:
        assert review(session).total == 1 and decisions(session)[0].dismissed_at is None
        with pytest.raises(HTTPException) as error:
            dismiss(session, 1, 2, request)
        assert error.value.status_code == 409


@pytest.mark.parametrize("side", [1, 2])
def test_trash_restore_dismissed_restore_and_cascade(scan_archive, side):
    engine, settings = scan_archive
    seed(engine, ["0000000000000000", "0000000000000001"])
    scan_duplicates(settings, apply=True)
    with Session(engine) as session:
        photo = session.get(Photo, side)
        mark_photos_trashed([photo], session)
        session.commit()
        assert review(session).total == 0
        restore_photo(side, session)
        assert review(session).total == 1
        dismiss(session, 1, 2, dismiss_request(decisions(session)[0]))
        mark_photos_trashed([session.get(Photo, side)], session)
        session.commit()
        restore_photo(side, session)
        assert summary(session).dismissed == 1 and review(session).total == 0
        session.delete(session.get(Photo, side))
        session.commit()
        assert decisions(session) == []


def test_foreign_keys_and_reversed_pair_constraints(scan_archive):
    engine, settings = scan_archive
    seed(engine, ["0000000000000000", "0000000000000001"])
    scan_duplicates(settings, apply=True)
    with Session(engine) as session:
        values = decisions(session)[0].model_dump()
        values.update(left_photo_id=2, right_photo_id=1)
        session.add(DuplicatePair(**values))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        values.update(left_photo_id=1, right_photo_id=999)
        session.add(DuplicatePair(**values))
        with pytest.raises(IntegrityError):
            session.commit()


@pytest.mark.parametrize(
    "options,limit", [({"max_pairs": 2}, "Pair"), ({"max_probes": 2}, "probe")]
)
def test_scan_limits_and_resume_preserve_last_successful_scan(
    scan_archive, options, limit
):
    engine, settings = scan_archive
    seed(engine, ["0000000000000000"] * 5)
    scan_duplicates(settings, apply=True)
    with Session(engine) as session:
        successful = session.get(DuplicateScanState, DETECTOR).last_successful_at
    stopped = scan_duplicates(settings, apply=True, **options)
    assert not stopped.complete and limit in stopped.reason
    assert stopped.pairs <= options.get("max_pairs", 10)
    assert stopped.probes <= options.get("max_probes", 50_000_000)
    with Session(engine) as session:
        state = session.get(DuplicateScanState, DETECTOR)
        assert state.status == "incomplete" and state.last_successful_at == successful
    assert scan_duplicates(settings, apply=True).complete
    with Session(engine) as session:
        assert len(decisions(session)) == 10


def test_interruption_and_external_commit_detection(scan_archive, monkeypatch):
    import app.services.duplicate_scan as scanning

    engine, settings = scan_archive
    seed(engine, ["0000000000000000"] * 6)
    monkeypatch.setattr(scanning, "BATCH_SIZE", 2)

    def interrupt(_processed, _total):
        raise KeyboardInterrupt

    result = scan_duplicates(settings, apply=True, progress=interrupt)
    assert not result.complete
    with Session(engine) as session:
        assert session.get(DuplicateScanState, DETECTOR).status == "incomplete"
        assert len(decisions(session)) == 1
    assert scan_duplicates(settings, apply=True).pairs == 15

    def modify(_processed, _total):
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute(
                "UPDATE photo SET display_title='external commit' WHERE id=1"
            )

    result = scan_duplicates(settings, apply=True, progress=modify)
    assert not result.complete and "externally" in result.reason
    with Session(engine) as session:
        assert session.get(DuplicateScanState, DETECTOR).status == "incomplete"


def test_exact_anomalies_are_reported_excluded_and_migration_idempotent(scan_archive):
    engine, settings = scan_archive
    seed(engine, ["0000000000000000"] * 2)
    with Session(engine) as session:
        photo = session.get(Photo, 2)
        photo.content_sha256 = session.get(Photo, 1).content_sha256
        session.add(photo)
        session.commit()
    groups = []
    result = scan_duplicates(settings, apply=True, exact_collision=groups.append)
    assert result.exact_groups == 1 and result.pairs == 0 and groups == [(1, 2)]
    assert run_migrations(engine, settings) == []
    assert (
        inspect_database(settings.database_path, LATEST_SCHEMA_VERSION).migrations[-1]
        == 16
    )


def test_index_all_matches_parity_and_sparse_work_budget():
    index = VisualDuplicateIndex()
    rng = random.Random(81)
    values = [f"{rng.getrandbits(64):016x}" for _ in range(3000)]
    values[5:10] = [
        "0000000000000000",
        "000000000000000f",
        "00000000000000ff",
        "000000000000001f",
        "0000000000000001",
    ]
    values[10] = "0000000000000003"
    probes = 0

    def visit():
        nonlocal probes
        probes += 1

    for i, value in enumerate(values):
        matches = {
            entry.photo_id
            for entry, _distance in index.iter_matches(value, visit=visit)
        }
        if i < 25:
            assert matches == {
                j
                for j, prior in enumerate(values[:i])
                if hamming_distance(prior, value) <= 4
            }
        index.add(VisualIndexEntry(i, value, ""))
    assert probes < len(values) * 5
    assert len(list(index.iter_matches("0000000000000000"))) > 3


def test_api_navigation_dismissal_staleness_and_upload_review(request):
    duplicate_lifecycle = request.getfixturevalue("duplicate_lifecycle")
    client, engine, _settings = duplicate_lifecycle
    first = post_image(client, encoded(scene(), quality=95)).json()
    warning = post_image(client, encoded(scene(), quality=55))
    assert warning.status_code == 409
    second = post_image(client, encoded(scene(), quality=55), allow=True).json()
    body = client.get("/duplicates/review").json()
    assert body["total"] == 1 and body["pair"]["identity"] == {
        "left": first["id"],
        "right": second["id"],
    }
    assert "perceptual_hash" not in body["pair"]["left_photo"]
    assert client.get("/duplicates/review?left=2&right=1").status_code == 422
    assert client.get("/duplicates/review?left=1").status_code == 422
    assert client.get("/duplicates/review?left=998&right=999").json()[
        "requested_pair_unavailable"
    ]
    pair = body["pair"]
    request = {"detector": DETECTOR, "expected_discovered_at": pair["discovered_at"]}
    stale = {
        **request,
        "expected_discovered_at": (utc_now() - timedelta(days=1)).isoformat(),
    }
    assert client.post("/duplicates/pairs/1/2/dismiss", json=stale).status_code == 409
    assert (
        client.post("/duplicates/pairs/1/2/dismiss", json=request).json()["remaining"]
        == 0
    )
    assert client.post("/duplicates/pairs/1/2/dismiss", json=request).status_code == 200
    assert client.get("/duplicates/summary").json()["dismissed"] == 1
    third = client.post(
        "/photos/upload",
        files={"file": ("reviewed.jpg", encoded(scene(), quality=65), "image/jpeg")},
        data={
            "allow_visual_duplicate": "true",
            "reviewed_candidate_ids": [str(first["id"])],
        },
    )
    assert third.status_code == 200, third.text
    with Session(engine) as session:
        assert (
            session.get(
                DuplicatePair, (first["id"], third.json()["id"], DETECTOR)
            ).dismissed_at
            is not None
        )
        assert (
            session.get(
                DuplicatePair, (second["id"], third.json()["id"], DETECTOR)
            ).dismissed_at
            is None
        )


@pytest.mark.parametrize("side", ["left", "right"])
def test_api_trash_restore_permanent_delete_and_stale_dismiss(request, side):
    duplicate_lifecycle = request.getfixturevalue("duplicate_lifecycle")
    client, _engine, _settings = duplicate_lifecycle
    post_image(client, encoded(scene(), quality=95))
    post_image(client, encoded(scene(), quality=55), allow=True)
    pair = client.get("/duplicates/review").json()["pair"]
    photo_id = pair["identity"][side]
    assert client.delete(f"/photos/{photo_id}").status_code == 200
    assert client.get("/duplicates/review").json()["total"] == 0
    assert (
        client.post(
            "/duplicates/pairs/1/2/dismiss",
            json={
                "detector": DETECTOR,
                "expected_discovered_at": pair["discovered_at"],
            },
        ).status_code
        == 409
    )
    assert client.post(f"/trash/photos/{photo_id}/restore").status_code == 200
    assert client.get("/duplicates/review").json()["total"] == 1
    client.delete(f"/photos/{photo_id}")
    assert client.delete(f"/trash/photos/{photo_id}").status_code == 200
    assert client.get("/duplicates/review").json()["pair"] is None
    assert (
        client.post(
            "/duplicates/pairs/1/2/dismiss",
            json={
                "detector": DETECTOR,
                "expected_discovered_at": pair["discovered_at"],
            },
        ).status_code
        == 404
    )


def test_heic_and_reviewed_id_validation_preserve_ingestion_safety(
    request,
):
    duplicate_lifecycle = request.getfixturevalue("duplicate_lifecycle")
    client, _engine, settings = duplicate_lifecycle
    heic_payload = encoded(scene(), "HEIF", quality=90)
    first = client.post(
        "/photos/upload",
        files={"file": ("source.heic", heic_payload, "image/heic")},
    )
    assert first.status_code == 200
    invalid = client.post(
        "/photos/upload",
        files={"file": ("invalid.jpg", encoded(scene(), quality=85), "image/jpeg")},
        data={"reviewed_candidate_ids": ["1"]},
    )
    assert invalid.status_code == 422 and not any(settings.staging_dir.iterdir())
    second = post_image(client, encoded(scene(), quality=80), allow=True)
    assert second.status_code == 200
    assert client.get("/duplicates/review").json()["total"] == 1
    exact = client.post(
        "/photos/upload",
        files={"file": ("renamed.heic", heic_payload, "image/heic")},
        data={"allow_visual_duplicate": "true"},
    )
    assert (
        exact.status_code == 409 and exact.json()["detail"]["code"] == "duplicate_photo"
    )


def test_candidate_commit_failure_rolls_back_ingestion_files(request, monkeypatch):
    import app.services.duplicate_review as duplicates

    client, engine, settings = request.getfixturevalue("duplicate_lifecycle")
    post_image(client, encoded(scene(), quality=95))
    before = {
        path: path.read_bytes()
        for directory in settings.image_dirs.values()
        for path in directory.iterdir()
    }

    def fail(_connection, _values):
        raise SQLAlchemyError("candidate write failed")

    monkeypatch.setattr(duplicates, "upsert_pairs", fail)
    assert (
        post_image(client, encoded(scene(), quality=55), allow=True).status_code == 500
    )
    assert {
        path: path.read_bytes()
        for directory in settings.image_dirs.values()
        for path in directory.iterdir()
    } == before
    assert not any(settings.staging_dir.iterdir())
    with Session(engine) as session:
        assert len(session.exec(select(Photo)).all()) == 1 and decisions(session) == []


def test_scan_cli_dry_run_limits_and_exit_codes(scan_archive, monkeypatch, capsys):
    import app.cli.maintenance as maintenance

    engine, settings = scan_archive
    seed(engine, ["0000000000000000"] * 3)
    monkeypatch.setattr(maintenance, "get_settings", lambda: settings)
    before = settings.database_path.read_bytes()
    assert maintenance.main(["duplicates-scan"]) == 0
    assert (
        "DRY RUN" in capsys.readouterr().out
        and settings.database_path.read_bytes() == before
    )
    assert maintenance.main(["duplicates-scan", "--max-probes", "0"]) == 2
    assert maintenance.main(["duplicates-scan", "--apply", "--max-pairs", "1"]) == 1
    assert maintenance.main(["duplicates-scan", "--apply"]) == 0
