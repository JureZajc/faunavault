from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from threading import Event

import pytest
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlmodel import Session, select

from app.models import ClassificationJob, DuplicatePair, Photo
from app.schemas import BulkMoveToTrashRequest
from app.services import bulk_photos
from app.services.duplicate_review import pair_values, upsert_pairs
from tests.test_catalog import add_photo
from tests.test_catalog import catalog_app as catalog_app


def cleanup(client, ids, **extra):
    return client.post(
        "/photos/bulk",
        json={
            "operation": "move_to_trash",
            "photo_ids": ids,
            "expected_culling_state": "reject",
            **extra,
        },
    )


def rejected(client):
    return client.get("/catalog/photos", params={"culling_state": "reject"}).json()


def test_membership_curation_cleanup_restore_and_smart_collection(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        for i, state in enumerate(("reject", "reject", "reject", "pick", None), 1):
            add_photo(
                session,
                i,
                culling_state=state,
                is_favorite=True,
                rating=5,
                status="needs_review",
                reviewed_at=datetime(2026, 1, 1),
                captured_at=datetime(2025, 6, 1),
                latitude=46.0,
                longitude=14.0,
                perceptual_hash="0000000000000000",
                content_sha256=f"{i:064x}",
            )
        add_photo(session, 6, culling_state="reject", deleted_at=datetime(2026, 1, 1))
        upsert_pairs(
            session.connection(),
            [pair_values(session.get(Photo, 1), session.get(Photo, 2))],
        )
        session.commit()
    smart = client.post(
        "/smart-collections",
        json={
            "name": "Rejects",
            "query_version": 1,
            "query": {"culling_state": "reject"},
        },
    ).json()
    smart_url = f"/smart-collections/{smart['id']}"
    definition = client.get(smart_url).json()
    assert rejected(client)["total"] == 3
    assert client.get("/duplicates/summary").json()["unresolved"] == 1
    for photo_id, state in ((2, "pick"), (3, None)):
        assert (
            client.patch(
                f"/photos/{photo_id}", json={"culling_state": state}
            ).status_code
            == 200
        )
    assert [p["id"] for p in rejected(client)["items"]] == [1]
    # A metadata update after selection does not block cleanup or get overwritten.
    client.patch("/photos/1", json={"rating": 4})
    before = client.get("/photos/1").json()
    assert cleanup(client, [1]).status_code == 200
    assert rejected(client)["total"] == 0
    assert client.get(smart_url + "/photos").json()["total"] == 0
    assert client.get("/duplicates/summary").json()["unresolved"] == 0
    trashed = next(
        p for p in client.get("/trash/photos").json()["items"] if p["id"] == 1
    )
    for field in (
        "culling_state",
        "is_favorite",
        "rating",
        "captured_at",
        "latitude",
        "longitude",
        "status",
        "reviewed_at",
    ):
        assert trashed[field] == before[field]
    assert client.get("/photos/2").json()["deleted_at"] is None
    assert client.post("/trash/photos/1/restore").status_code == 200
    assert [p["id"] for p in rejected(client)["items"]] == [1]
    assert client.get(smart_url + "/photos").json()["total"] == 1
    assert client.get(smart_url).json() == definition
    assert client.get("/duplicates/summary").json()["unresolved"] == 1
    with Session(engine) as session:
        assert session.exec(select(ClassificationJob)).all() == []
        assert session.exec(select(DuplicatePair)).one().dismissed_at is None


@pytest.mark.parametrize(
    "other,expected,code",
    [
        ("pick", 409, "photos_not_rejected"),
        (None, 409, "photos_not_rejected"),
        ("trash", 409, "photos_not_active"),
        ("missing", 404, "photos_not_found"),
    ],
)
def test_guard_failure_is_atomic(catalog_app, other, expected, code):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, culling_state="reject")
        if other != "missing":
            add_photo(
                session,
                2,
                culling_state="reject" if other == "trash" else other,
                deleted_at=datetime(2026, 1, 1) if other == "trash" else None,
            )
        session.commit()
    response = cleanup(client, [1, 2])
    assert response.status_code == expected
    assert response.json()["detail"]["code"] == code
    assert response.json()["detail"]["photo_ids"] == [2]
    assert client.get("/photos/1").json()["deleted_at"] is None


def test_guard_validation_rollback_and_legacy_compatibility(catalog_app, monkeypatch):
    client, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, culling_state="reject")
        add_photo(session, 2, culling_state="pick")
        session.commit()
    for ids, status in (
        ([], 422),
        ([1, 1], 422),
        ([0], 422),
        (list(range(1, 252)), 413),
    ):
        assert cleanup(client, ids).status_code == status
    for state in ("pick", "undecided", True):
        assert cleanup(client, [1], expected_culling_state=state).status_code == 422
    assert (
        client.post(
            "/photos/bulk",
            json={
                "operation": "clear_culling_state",
                "photo_ids": [1],
                "expected_culling_state": "reject",
            },
        ).status_code
        == 422
    )
    with monkeypatch.context() as patcher:

        def fail(_session):
            raise SQLAlchemyError("injected commit failure")

        patcher.setattr(Session, "commit", fail)
        assert cleanup(client, [1]).status_code == 500
    assert client.get("/photos/1").json()["deleted_at"] is None
    assert (
        client.post(
            "/photos/bulk", json={"operation": "move_to_trash", "photo_ids": [2]}
        ).status_code
        == 200
    )


def test_guard_holds_write_lock_through_validation_and_commit(catalog_app, monkeypatch):
    _, engine = catalog_app
    with Session(engine) as session:
        add_photo(session, 1, culling_state="reject")
        session.commit()
    loaded, release = Event(), Event()
    original = bulk_photos._load_active_photos

    def paused_load(ids, session):
        photos = original(ids, session)
        loaded.set()
        assert release.wait(5)
        return photos

    monkeypatch.setattr(bulk_photos, "_load_active_photos", paused_load)

    def run():
        with Session(engine) as session:
            return bulk_photos.apply_bulk_photo_action(
                BulkMoveToTrashRequest(
                    photo_ids=[1],
                    operation="move_to_trash",
                    expected_culling_state="reject",
                ),
                session,
            )

    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(run)
        try:
            assert loaded.wait(5)
            with Session(engine) as writer:
                writer.connection().exec_driver_sql("PRAGMA busy_timeout=0")
                with pytest.raises(OperationalError, match="locked"):
                    writer.connection().exec_driver_sql(
                        "UPDATE photo SET culling_state='pick' WHERE id=1"
                    )
                writer.rollback()
        finally:
            release.set()
        assert result.result(timeout=5).affected_count == 1
    with Session(engine) as session:
        assert session.get(Photo, 1).deleted_at is not None
        assert session.get(Photo, 1).culling_state == "reject"
