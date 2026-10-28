from __future__ import annotations

# ruff: noqa: F811
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session

from app.archive_export.schema import ArchiveMetadataExport
from app.archive_export.service import create_metadata_export
from app.archive_integrity import (
    ArchiveIntegrityError,
    inspect_database,
    read_collection_signature,
)
from app.backup.manifest import DATABASE_BACKUP_PATH
from app.backup.rehearsal import RehearsalError, rehearse_backup
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.migrations import run_migrations
from app.services import collections
from tests.test_collections import collections_app, create, seed_photos  # noqa: F401
from tests.test_photo_lifecycle import jpeg_bytes, lifecycle  # noqa: F401
from tests.test_restore_rehearsal import _refresh_database_manifest


def member_collection(client, ids):
    item = create(client, "Covered collection")
    assert (
        client.post(
            f"/collections/{item['id']}/photos", json={"photo_ids": ids}
        ).status_code
        == 200
    )
    return item, f"/collections/{item['id']}"


def test_cover_selection_validation_idempotence_and_fallback(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=4, trashed={4})
    item, url = member_collection(client, ids[:2])
    assert item["cover_photo_id"] is item["cover_photo"] is None
    before = client.get(url).json()
    assert before["cover_photo_id"] is None and before["cover_photo"]["id"] == ids[1]
    assert (
        client.patch("/collections/9999/cover", json={"photo_id": ids[0]}).json()[
            "detail"
        ]["code"]
        == "collection_not_found"
    )
    for identity, status, code in [
        (9999, 404, "photo_not_found"),
        (ids[2], 409, "photo_not_collection_member"),
        (ids[3], 409, "photo_not_active"),
    ]:
        rejected = client.patch(url + "/cover", json={"photo_id": identity})
        assert (
            rejected.status_code == status and rejected.json()["detail"]["code"] == code
        )
    for body in [
        {},
        {"photo_id": True},
        {"photo_id": "1"},
        {"photo_id": 0},
        {"photo_id": 1.5},
        {"photo_id": 2**63},
        {"photo_id": None, "title": "Oops"},
    ]:
        assert client.patch(url + "/cover", json=body).status_code == 422
    selected = client.patch(url + "/cover", json={"photo_id": ids[0]}).json()
    assert selected["cover_photo_id"] == selected["cover_photo"]["id"] == ids[0]
    assert selected["updated_at"] != before["updated_at"]
    for field in (
        "name",
        "active_photo_count",
    ):
        assert selected[field] == before[field]
    assert set(selected["cover_photo"]) == {
        "id",
        "thumbnail_filename",
        "original_filename",
        "display_title",
    }
    writes = []

    def trace(_conn, _cursor, statement, *_args):
        if statement.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE")):
            writes.append(statement)

    event.listen(engine, "before_cursor_execute", trace)
    try:
        assert (
            client.patch(url + "/cover", json={"photo_id": ids[0]}).json() == selected
        )
    finally:
        event.remove(engine, "before_cursor_execute", trace)
    assert writes == []
    cleared = client.patch(url + "/cover", json={"photo_id": None}).json()
    assert cleared["cover_photo_id"] is None and cleared["cover_photo"]["id"] == ids[1]
    assert cleared["updated_at"] != selected["updated_at"]
    assert client.patch(url + "/cover", json={"photo_id": None}).json() == cleared


def test_cover_trash_restore_remove_purge_and_collection_deletion(lifecycle):
    client, engine, settings = lifecycle
    ids = []
    for name, color in [("one", "red"), ("two", "blue")]:
        response = client.post(
            "/photos/upload",
            data={"allow_visual_duplicate": "true"},
            files={"file": (name + ".jpg", jpeg_bytes(color), "image/jpeg")},
        )
        assert response.status_code == 200, response.text
        ids.append(response.json()["id"])
    item, url = member_collection(client, ids)
    client.patch(url + "/cover", json={"photo_id": ids[0]})
    assert client.delete(f"/photos/{ids[0]}").status_code == 200
    hidden = client.get(url).json()
    assert hidden["cover_photo_id"] == ids[0] and hidden["cover_photo"]["id"] == ids[1]
    assert inspect_database(settings.database_path, 21).collections == 1
    client.post(f"/trash/photos/{ids[0]}/restore")
    assert client.get(url).json()["cover_photo"]["id"] == ids[0]
    assert (
        client.request(
            "DELETE", url + "/photos", json={"photo_ids": [ids[0]]}
        ).status_code
        == 200
    )
    assert client.get(url).json()["cover_photo_id"] is None
    client.post(url + "/photos", json={"photo_ids": [ids[0]]})
    assert client.get(url).json()["cover_photo_id"] is None
    client.patch(url + "/cover", json={"photo_id": ids[0]})
    client.delete(f"/photos/{ids[0]}")
    assert client.delete(f"/trash/photos/{ids[0]}").status_code == 200
    assert client.get(url).json()["cover_photo_id"] is None
    client.patch(url + "/cover", json={"photo_id": ids[1]})
    assert client.delete(url).status_code == 200
    assert client.get(f"/photos/{ids[1]}").status_code == 200
    assert inspect_database(settings.database_path, 21).collections == 0


def test_empty_and_all_trashed_covers_and_order_ties(collections_app):
    client, engine, settings = collections_app
    ids = seed_photos(engine, count=3)
    _, url = member_collection(client, ids)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("UPDATE photo SET created_at='2026-01-01T00:00:00'")
    assert client.get(url).json()["cover_photo"]["id"] == ids[-1]
    client.patch(url + "/cover", json={"photo_id": ids[0]})
    for identity in ids:
        client.delete(f"/photos/{identity}")
    hidden = client.get(url).json()
    assert hidden["cover_photo_id"] == ids[0] and hidden["cover_photo"] is None
    assert (
        client.request(
            "DELETE", url + "/photos", json={"photo_ids": [ids[0]]}
        ).status_code
        == 200
    )
    client.post(f"/trash/photos/{ids[0]}/restore")
    assert client.get(url).json()["cover_photo"] is None
    empty = create(client, "Empty")
    assert client.get(f"/collections/{empty['id']}").json()["cover_photo"] is None


def test_cover_listing_has_constant_query_count(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=6)
    for index in range(30):
        item = create(client, f"Collection {index:02}")
        url = f"/collections/{item['id']}"
        client.post(url + "/photos", json={"photo_ids": ids})
        client.patch(url + "/cover", json={"photo_id": ids[index % 6]})
    queries = []

    def trace(_conn, _cursor, statement, *_args):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(statement)

    event.listen(engine, "before_cursor_execute", trace)
    try:
        listing = client.get("/collections").json()
    finally:
        event.remove(engine, "before_cursor_execute", trace)
    assert len(listing) == 30 and len(queries) == 2
    assert all(item["cover_photo_id"] == item["cover_photo"]["id"] for item in listing)
    assert all(
        "stored_filename" not in query and "resized_filename" not in query
        for query in queries
    )


@pytest.mark.parametrize("operation", ["cover", "membership"])
def test_failed_cover_or_removal_commit_rolls_back_the_entire_change(
    collections_app, monkeypatch, operation
):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=2)
    item, url = member_collection(client, ids)
    client.patch(url + "/cover", json={"photo_id": ids[0]})
    before = client.get(url).json()
    with Session(engine) as session:

        def fail():
            raise SQLAlchemyError("injected commit failure")

        monkeypatch.setattr(session, "commit", fail)
        with pytest.raises(HTTPException) as failure:
            if operation == "cover":
                collections.update_cover(item["id"], ids[1], session)
            else:
                collections.remove_collection_photos(item["id"], [ids[0]], session)
        assert failure.value.status_code == 500
    assert client.get(url).json() == before


def test_cover_foreign_key_nulls_on_direct_photo_deletion(collections_app):
    client, engine, settings = collections_app
    ids = seed_photos(engine, count=1)
    _, url = member_collection(client, ids)
    client.patch(url + "/cover", json={"photo_id": ids[0]})
    with engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM photo WHERE id=?", (ids[0],))
    assert client.get(url).json()["cover_photo_id"] is None
    assert inspect_database(settings.database_path, 21).collection_memberships == 0


def test_cover_busy_writer_returns_retryable_error(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    item, url = member_collection(client, ids)

    def blocked_write():
        with Session(engine) as session:
            session.connection().exec_driver_sql("PRAGMA busy_timeout=1")
            with pytest.raises(HTTPException) as failure:
                collections.update_cover(item["id"], ids[0], session)
            assert failure.value.status_code == 409
            assert failure.value.detail["code"] == "collection_busy"

    with Session(engine) as writer:
        writer.connection().exec_driver_sql("BEGIN IMMEDIATE")
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(blocked_write).result(timeout=5)
    assert client.get(url).json()["cover_photo_id"] is None


@pytest.mark.parametrize("first", ["cover", "membership"])
def test_concurrent_membership_and_cover_are_serialized(
    collections_app, monkeypatch, first
):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=1)
    item, url = member_collection(client, ids)
    validated, attempted, release = Event(), Event(), Event()
    commit = Session.commit

    def pause_commit(session):
        validated.set()
        assert release.wait(5)
        commit(session)

    monkeypatch.setattr(Session, "commit", pause_commit)

    def mutate(kind):
        with Session(engine) as session:
            if kind == "cover":
                return collections.update_cover(item["id"], ids[0], session)
            return collections.remove_collection_photos(item["id"], ids, session)

    def trace(_conn, _cursor, statement, *_args):
        if statement == "BEGIN IMMEDIATE" and validated.is_set():
            attempted.set()

    event.listen(engine, "before_cursor_execute", trace)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            leading = pool.submit(mutate, first)
            assert validated.wait(5)
            following = pool.submit(
                mutate, "membership" if first == "cover" else "cover"
            )
            try:
                assert attempted.wait(5)
                assert not following.done()
            finally:
                release.set()
            leading.result(timeout=5)
            if first == "cover":
                following.result(timeout=5)
            else:
                with pytest.raises(HTTPException) as failure:
                    following.result(timeout=5)
                assert failure.value.detail["code"] == "photo_not_collection_member"
    finally:
        release.set()
        event.remove(engine, "before_cursor_execute", trace)
    assert client.get(url).json()["cover_photo_id"] is None


def test_migration21_from_actual_schema20_is_retryable(collections_app):
    client, engine, settings = collections_app
    ids = seed_photos(engine, count=1)
    _, url = member_collection(client, ids)
    with sqlite3.connect(settings.database_path) as connection:
        # Rebuild the historical table because SQLite cannot drop table-level FKs.
        connection.execute(
            "CREATE TEMP TABLE saved_collections AS SELECT id, name, name_key, created_at, updated_at FROM collection"
        )
        connection.execute("DROP TABLE collection")
        connection.execute("""CREATE TABLE collection (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
            name_key TEXT NOT NULL CHECK (length(name_key) >= 1),
            created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
            CONSTRAINT uq_collection_name_key UNIQUE (name_key)
        )""")
        connection.execute("INSERT INTO collection SELECT * FROM saved_collections")
        connection.execute("DELETE FROM schema_migration WHERE version=21")
    assert inspect_database(settings.database_path, 20).collection_memberships == 1
    before = read_collection_signature(settings.database_path)
    assert run_migrations(engine, settings) == [21]
    assert run_migrations(engine, settings) == []
    assert inspect_database(settings.database_path, 21).collection_memberships == 1
    assert read_collection_signature(settings.database_path) == before
    assert client.get(url).json()["cover_photo_id"] is None
    # Retry a partially applied migration without rebuilding its existing column.
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP INDEX ix_collection_cover_photo_id")
        connection.exec_driver_sql("DELETE FROM schema_migration WHERE version=21")
    assert run_migrations(engine, settings) == [21]
    inspect_database(settings.database_path, 21)


def test_cover_backup_restore_export_and_change_detection(lifecycle, tmp_path_factory):
    client, _, settings = lifecycle
    photo = client.post(
        "/photos/upload", files={"file": ("cover.jpg", jpeg_bytes(), "image/jpeg")}
    ).json()
    item, url = member_collection(client, [photo["id"]])
    client.patch(url + "/cover", json={"photo_id": photo["id"]})
    client.delete(f"/photos/{photo['id']}")
    root = tmp_path_factory.mktemp("covers")
    exported = create_metadata_export(root / "export", settings)
    repeated = create_metadata_export(root / "export-again", settings)
    assert exported.json_path.read_bytes() == repeated.json_path.read_bytes()
    payload = json.loads(exported.json_path.read_text())
    assert (
        payload["format_version"] == 12
        and payload["collections"][0]["cover_photo_id"] == photo["id"]
    )
    payload["collections"][0]["cover_photo_id"] = 99999
    with pytest.raises(ValidationError, match="cover"):
        ArchiveMetadataExport.model_validate(payload)
    (root / "backups").mkdir()
    backup, verification = create_backup(root / "backups", settings)
    assert verification.valid and verification.manifest.database.schema_version == 21
    assert rehearse_backup(backup, root / "restored").doctor_status == "HEALTHY"
    assert read_collection_signature(
        settings.database_path
    ) == read_collection_signature(root / "restored/data/faunavault.db")

    def change_cover():
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("UPDATE collection SET cover_photo_id=NULL")

    with pytest.raises(ArchiveIntegrityError, match="Collection.*changed"):
        create_backup(root / "backups", settings, before_publish=change_cover)
    assert client.get(url).json()["cover_photo_id"] is None


@pytest.mark.parametrize("damage", ["nonmember", "dangling", "index", "foreign_key"])
def test_invalid_covers_fail_backup_verification_before_restore(
    lifecycle, tmp_path_factory, damage
):
    client, _, settings = lifecycle
    photo = client.post(
        "/photos/upload", files={"file": ("cover.jpg", jpeg_bytes(), "image/jpeg")}
    ).json()
    _, url = member_collection(client, [photo["id"]])
    client.patch(url + "/cover", json={"photo_id": photo["id"]})
    root = tmp_path_factory.mktemp("invalid-cover")
    backup, _ = create_backup(root, settings)
    with sqlite3.connect(backup / DATABASE_BACKUP_PATH) as connection:
        if damage == "nonmember":
            connection.execute("DELETE FROM collection_photo")
        elif damage == "dangling":
            connection.execute("UPDATE collection SET cover_photo_id=99999")
        elif damage == "foreign_key":
            connection.execute("PRAGMA writable_schema=ON")
            connection.execute(
                "UPDATE sqlite_master SET sql=replace(sql, 'SET NULL', 'NO ACTION') WHERE name='collection'"
            )
        else:
            connection.execute("DROP INDEX ix_collection_cover_photo_id")
    _refresh_database_manifest(backup)
    assert not verify_backup(backup).valid
    with pytest.raises(RehearsalError) as failure:
        rehearse_backup(backup, root / "restore")
    assert (
        failure.value.stage == "backup verification" and not (root / "restore").exists()
    )
