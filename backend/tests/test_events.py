from __future__ import annotations

# ruff: noqa: F811
import json
import sqlite3
from datetime import datetime
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app.archive_export.schema import ArchiveMetadataExport
from app.archive_export.service import create_metadata_export
from app.archive_integrity import (
    ArchiveIntegrityError,
    inspect_database,
    read_event_signature,
)
from app.backup.manifest import DATABASE_BACKUP_PATH
from app.backup.rehearsal import RehearsalError, rehearse_backup
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.migrations import run_migrations
from app.models import (
    ArchiveEvent,
    ArchiveEventPhoto,
    ClassificationJob,
    DuplicatePair,
    ImportSession,
    Photo,
)
from app.services.events import change_membership
from tests.test_catalog import add_photo, add_taxon
from tests.test_collections import collections_app, seed_photos  # noqa: F401
from tests.test_photo_lifecycle import jpeg_bytes, lifecycle  # noqa: F401
from tests.test_restore_rehearsal import (
    _intermediate_backup,
    _refresh_database_manifest,
)


def create(client, **values):
    response = client.post(
        "/events",
        json={
            "kind": "trip",
            "title": " Valencia  2026 ",
            "start_date": "2026-08-12",
            "end_date": "2026-08-17",
            **values,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_event_metadata_validation_and_nonreused_identity(collections_app):
    client, _, _ = collections_app
    trip = create(client, location_label=" Valencia, Spain ", notes=" first\nsecond ")
    assert trip["title"] == "Valencia 2026" and trip["notes"] == "first\nsecond"
    assert (
        create(client, title=" " * 100 + "Padded", notes=" " * 2001)["title"]
        == "Padded"
    )
    assert create(client, kind="event")["kind"] == "event"
    assert (
        create(client, start_date="2026-08-12", end_date="2026-08-12")[
            "active_photo_count"
        ]
        == 0
    )
    for values in (
        {"title": "  "},
        {"kind": "Trip"},
        {"start_date": "2026-08-18"},
        {"start_date": "2026-02-30"},
        {"start_date": "2026-08-12T00:00:00"},
        {"location_label": "x" * 201},
        {"notes": "x" * 2001},
        {"title": 12},
    ):
        assert (
            client.post(
                "/events",
                json={
                    "kind": "trip",
                    "title": "test",
                    "start_date": "2026-08-12",
                    "end_date": "2026-08-17",
                    **values,
                },
            ).status_code
            == 422
        )
    assert (
        client.patch(
            f"/events/{trip['id']}", json={"start_date": "2026-08-19"}
        ).status_code
        == 422
    )
    assert (
        client.patch(f"/events/{trip['id']}", json={"title": None}).status_code == 422
    )
    assert client.patch(f"/events/{trip['id']}", json={}).status_code == 422
    changed = client.patch(
        f"/events/{trip['id']}",
        json={"kind": "event", "location_label": " ", "notes": None},
    ).json()
    assert (
        changed["kind"] == "event"
        and changed["location_label"] is None
        and changed["notes"] is None
    )
    highest = create(client)
    assert client.delete(f"/events/{highest['id']}").status_code == 200
    assert create(client)["id"] > highest["id"]
    assert client.get(f"/events/{highest['id']}").status_code == 404
    assert client.get(f"/events/{2**63}").status_code == 422


def test_explicit_membership_atomicity_and_photo_independence(
    collections_app, monkeypatch
):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=3, trashed={3})
    with Session(engine) as session:
        photo = session.get(Photo, ids[0])
        photo.status, photo.confidence, photo.reviewed_at = (
            "classified",
            0.9,
            photo.updated_at,
        )
        session.add(photo)
        session.add(
            ClassificationJob(
                photo_id=ids[0],
                status="failed",
                batch_id="event-test",
                batch_kind="single",
                requested_model="offline",
                prompt_version="v1",
                source_photo_updated_at=photo.updated_at,
            )
        )
        session.add(
            DuplicatePair(
                left_photo_id=ids[0],
                right_photo_id=ids[1],
                detector="phash64-v1:d4",
                left_hash="0000000000000000",
                right_hash="0000000000000001",
                distance=1,
                dismissed_at=photo.updated_at,
            )
        )
        session.commit()

    def independent_state():
        with sqlite3.connect(collections_app[2].database_path) as connection:
            return tuple(connection.execute("SELECT * FROM classification_job")), tuple(
                connection.execute("SELECT * FROM duplicate_pair")
            )

    before_independent = independent_state()
    first, second = create(client), create(client, kind="event")
    href = f"/events/{first['id']}/photos"
    before = client.get(f"/photos/{ids[0]}").json()
    assert client.post(href, json={"photo_ids": ids}).status_code == 409
    assert client.get(f"/events/{first['id']}").json()["active_photo_count"] == 0
    assert client.post(href, json={"photo_ids": [ids[0], 99999]}).status_code == 404
    for values, status in (
        ([], 422),
        ([1, 1], 422),
        ([True], 422),
        ([0], 422),
        ([2**63], 422),
        (list(range(1, 252)), 413),
    ):
        assert client.post(href, json={"photo_ids": values}).status_code == status
    assert client.post(href, json={"photo_ids": ids[:2]}).json()["added_count"] == 2
    assert (
        client.post(href, json={"photo_ids": ids[:2]}).json()["already_present_count"]
        == 2
    )
    client.post(f"/events/{second['id']}/photos", json={"photo_ids": [ids[0]]})
    assert client.get(f"/photos/{ids[0]}").json() == before
    client.patch(
        f"/events/{first['id']}",
        json={"start_date": "2025-01-01", "end_date": "2025-01-01"},
    )
    assert (
        client.get("/catalog/photos", params={"event_id": first["id"]}).json()["total"]
        == 2
    )
    client.patch(
        f"/photos/{ids[0]}",
        params={"expected_updated_at": before["updated_at"]},
        json={"captured_at": "2020-01-01T12:00:00", "captured_at_offset_minutes": None},
    )
    assert (
        client.get("/catalog/photos", params={"event_id": first["id"]}).json()["total"]
        == 2
    )
    removed = client.request("DELETE", href, json={"photo_ids": ids[:2]}).json()
    assert removed["removed_count"] == 2
    assert client.get(f"/photos/{ids[0]}").status_code == 200
    with Session(engine) as session:
        with monkeypatch.context() as patch:
            patch.setattr(
                session,
                "commit",
                lambda: (_ for _ in ()).throw(SQLAlchemyError("failure")),
            )
            with pytest.raises(HTTPException, match="500"):
                change_membership(first["id"], ids[:2], session, adding=True)
        assert (
            session.exec(
                select(ArchiveEventPhoto).where(
                    ArchiveEventPhoto.event_id == first["id"]
                )
            ).all()
            == []
        )
    client.delete(f"/events/{second['id']}")
    assert client.get(f"/photos/{ids[0]}").status_code == 200
    assert independent_state() == before_independent


def test_event_catalog_suggestions_map_culling_and_index(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=7)
    trip = create(client)
    with Session(engine) as session:
        for index, identity in enumerate(ids):
            photo = session.get(Photo, identity)
            photo.captured_at = [
                datetime(2026, 8, 12),
                datetime(2026, 8, 17, 23, 59, 59),
                datetime(2026, 8, 11),
                datetime(2026, 8, 18),
                None,
                datetime(2026, 8, 13),
                datetime(2026, 8, 13),
            ][index]
            photo.is_favorite = index == 0
            photo.rating = 5 if index == 0 else None
            photo.culling_state = (
                "pick" if index == 0 else "reject" if index == 1 else None
            )
            photo.latitude, photo.longitude = (46, 14) if index == 0 else (None, None)
            session.add(photo)
        session.commit()
    suggested = client.get(
        "/catalog/photos",
        params={"taken_from": trip["start_date"], "taken_to": trip["end_date"]},
    ).json()
    assert {photo["id"] for photo in suggested["items"]} == {
        ids[0],
        ids[1],
        ids[5],
        ids[6],
    }
    assert client.get(f"/events/{trip['id']}").json()["active_photo_count"] == 0
    client.post(f"/events/{trip['id']}/photos", json={"photo_ids": ids[:5]})
    for filters, expected in (
        ({}, 5),
        ({"favorites_only": True}, 1),
        ({"rating": 5}, 1),
        ({"culling_state": "pick"}, 1),
        ({"search": "photo-1"}, 1),
        ({"search": "photo-7"}, 0),
        ({"taken_from": "2026-08-12", "taken_to": "2026-08-17"}, 2),
    ):
        page = client.get(
            "/catalog/photos",
            params={"event_id": trip["id"], "page_size": 1, **filters},
        ).json()
        assert page["total"] == expected
        assert len(page["items"]) == min(expected, 1)
    assert [
        photo["id"]
        for photo in client.get("/catalog/map", params={"event_id": trip["id"]}).json()
    ] == [ids[0]]
    assert client.get(
        "/catalog/culling", params={"event_id": trip["id"], "photo_id": ids[6]}
    ).json()["requested_photo_unavailable"]
    assert (
        client.get("/catalog/culling", params={"event_id": trip["id"]}).json()["total"]
        == 5
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Event",
                "query_version": 1,
                "query": {"event_id": trip["id"]},
            },
        ).status_code
        == 422
    )
    for route in ("photos", "map", "culling"):
        assert (
            client.get(f"/catalog/{route}", params={"event_id": 2**63}).status_code
            == 422
        )
        assert (
            client.get(f"/catalog/{route}", params={"event_id": 9999}).status_code
            == 404
        )
        assert (
            client.get(f"/catalog/{route}", params={"event_id": 0}).status_code == 422
        )
    for _ in range(5):
        create(client, kind="event")
    statements = []

    def record(_connection, _cursor, statement, *_args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        index = client.get("/events", params={"page_size": 10}).json()
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len(statements) == 4
    assert [item["id"] for item in index["items"]] == sorted(
        [item["id"] for item in index["items"]], reverse=True
    )
    preview = next(item for item in index["items"] if item["id"] == trip["id"])
    assert len(preview["previews"]) == 4 and preview["active_photo_count"] == 5
    assert client.get("/events", params={"kind": "trip"}).json()["total"] == 1
    assert client.get("/events", params={"page_size": 101}).status_code == 422


def test_event_lifecycle_and_artifacts(lifecycle, tmp_path_factory):
    client, engine, settings = lifecycle
    photo = client.post(
        "/photos/upload", files={"file": ("event.jpg", jpeg_bytes(), "image/jpeg")}
    ).json()
    trip = create(client)
    client.post(f"/events/{trip['id']}/photos", json={"photo_ids": [photo["id"]]})
    client.delete(f"/photos/{photo['id']}")
    detail = client.get(f"/events/{trip['id']}").json()
    assert detail["active_photo_count"] == 0 and detail["trash_photo_count"] == 1
    root = tmp_path_factory.mktemp("event-artifacts")
    first = create_metadata_export(root / "export", settings, include_csv=True)
    second = create_metadata_export(root / "again", settings, include_csv=True)
    assert first.json_path.read_bytes() == second.json_path.read_bytes()
    assert first.csv_path.read_bytes() == second.csv_path.read_bytes()
    payload = json.loads(first.json_path.read_text())
    assert (
        payload["format_version"] == 10
        and payload["archive_events"][0]["id"] == trip["id"]
    )
    assert payload["archive_event_photos"] == [
        {"event_id": trip["id"], "photo_id": photo["id"]}
    ]
    invalid = json.loads(first.json_path.read_text())
    invalid["archive_event_photos"][0]["event_id"] = 9999
    with pytest.raises(ValidationError, match="absent from the export"):
        ArchiveMetadataExport.model_validate(invalid)
    (root / "backups").mkdir()
    backup, verification = create_backup(root / "backups", settings)
    assert verification.valid and verify_backup(backup).valid
    result = rehearse_backup(backup, root / "recovered")
    assert result.archive_events == result.archive_event_memberships == 1
    assert read_event_signature(settings.database_path) == read_event_signature(
        root / "recovered/data/faunavault.db"
    )

    def change():
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("UPDATE archive_event SET notes='changed'")

    with pytest.raises(ArchiveIntegrityError, match="Trip/Event.*changed"):
        create_backup(root / "backups", settings, before_publish=change)

    def change_memberships():
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("DELETE FROM archive_event_photo")

    with pytest.raises(ArchiveIntegrityError, match="Trip/Event.*changed"):
        create_backup(root / "backups", settings, before_publish=change_memberships)
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "INSERT INTO archive_event_photo VALUES (?, ?)", (trip["id"], photo["id"])
        )
    client.post(f"/trash/photos/{photo['id']}/restore")
    assert client.get(f"/events/{trip['id']}").json()["active_photo_count"] == 1
    client.delete(f"/photos/{photo['id']}")
    client.delete(f"/trash/photos/{photo['id']}")
    assert client.get(f"/events/{trip['id']}").json()["trash_photo_count"] == 0
    with Session(engine) as session:
        assert session.get(ArchiveEvent, trip["id"]) is not None
        assert session.exec(select(ArchiveEventPhoto)).all() == []


@pytest.mark.parametrize("damage", ["table", "column", "index", "metadata", "join"])
def test_schema19_structural_and_data_validation(collections_app, damage):
    client, _, settings = collections_app
    create(client)
    with sqlite3.connect(settings.database_path) as connection:
        if damage == "table":
            connection.execute("DROP TABLE archive_event_photo")
        elif damage == "column":
            connection.execute("ALTER TABLE archive_event DROP COLUMN updated_at")
        elif damage == "index":
            connection.execute("DROP INDEX ix_archive_event_photo_photo_event")
        elif damage == "metadata":
            connection.execute("PRAGMA ignore_check_constraints=ON")
            connection.execute("UPDATE archive_event SET start_date='invalid'")
        else:
            connection.execute("INSERT INTO archive_event_photo VALUES (9999, 9999)")
    with pytest.raises(ArchiveIntegrityError):
        inspect_database(settings.database_path, 19)


def test_event_composes_with_taxon_import_sort_and_culling_neighbors(collections_app):
    client, engine, _ = collections_app
    trip = create(client)
    identity = str(uuid4())
    with Session(engine) as session:
        session.add(ImportSession(id=identity, source_kind="browser", imported_count=4))
        fox = add_taxon(session, "Vulpes vulpes")
        bird = add_taxon(session, "Test bird")
        photos = [
            add_photo(
                session,
                1,
                taxon=fox,
                import_session_id=identity,
                is_favorite=True,
                rating=5,
                culling_state="pick",
            ),
            add_photo(session, 2, taxon=fox, import_session_id=identity),
            add_photo(session, 3, taxon=bird, import_session_id=identity),
            add_photo(session, 4, taxon=fox, import_session_id=identity),
        ]
        session.commit()
        ids, taxon_id = [photo.id for photo in photos], fox.id
    client.post(
        f"/events/{trip['id']}/photos", json={"photo_ids": [ids[0], ids[2], ids[3]]}
    )
    query = {
        "event_id": trip["id"],
        "import_session_id": identity,
        "taxon_id": taxon_id,
    }
    for search in (None, "photo", "vulpes"):
        response = client.get(
            "/catalog/photos",
            params={
                **query,
                **({"search": search} if search else {}),
                "sort": "created_at",
                "order": "asc",
                "page_size": 1,
                "page": 2,
            },
        ).json()
        assert response["total"] == 2 and response["items"][0]["id"] == ids[3]
    response = client.get(
        "/catalog/photos",
        params={
            **query,
            "favorites_only": True,
            "rating_min": 4,
            "culling_state": "pick",
        },
    ).json()
    assert response["total"] == 1 and response["items"][0]["id"] == ids[0]
    workspace = client.get(
        "/catalog/culling",
        params={**query, "photo_id": ids[0], "sort": "created_at", "order": "asc"},
    ).json()
    assert workspace["photo"]["id"] == ids[0]
    assert (
        workspace["next_photo_id"] == ids[3] and workspace["previous_photo_id"] is None
    )
    assert workspace["total"] == 2


def test_schema19_retry_preserves_photos_and_empty_events(lifecycle, monkeypatch):
    import app.migrations as migrations

    client, engine, settings = lifecycle
    photo = client.post(
        "/photos/upload", files={"file": ("event.jpg", jpeg_bytes(), "image/jpeg")}
    ).json()
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE archive_event_photo")
        connection.exec_driver_sql("DROP TABLE archive_event")
        connection.exec_driver_sql("DELETE FROM schema_migration WHERE version=19")
    assert inspect_database(settings.database_path, 18).migrations[-1] == 18

    def partial_failure(connection):
        ArchiveEvent.__table__.create(connection, checkfirst=True)
        ArchiveEventPhoto.__table__.create(connection, checkfirst=True)
        connection.exec_driver_sql("DROP INDEX ix_archive_event_photo_photo_event")
        raise RuntimeError("migration19 interrupted")

    with monkeypatch.context() as patch:
        patch.setattr(migrations, "_migration_19", partial_failure)
        with pytest.raises(RuntimeError, match="interrupted"):
            run_migrations(engine, settings)
    assert run_migrations(engine, settings) == [19]
    assert run_migrations(engine, settings) == []
    inventory = inspect_database(settings.database_path, 19)
    assert inventory.archive_events == inventory.archive_event_memberships == 0
    assert client.get(f"/photos/{photo['id']}").json() == photo


@pytest.mark.parametrize("damage", ["key", "cascade", "constraint", "index"])
def test_empty_schema19_damage_rejected_before_rehearsal_writes(
    tmp_path, monkeypatch, damage
):
    backup = _intermediate_backup(tmp_path, monkeypatch, 19)
    with sqlite3.connect(backup / DATABASE_BACKUP_PATH) as connection:
        if damage in {"key", "cascade"}:
            connection.execute("DROP TABLE archive_event_photo")
            primary = (
                "PRIMARY KEY (event_id, photo_id)"
                if damage == "cascade"
                else "PRIMARY KEY (event_id)"
            )
            cascade = "" if damage == "cascade" else " ON DELETE CASCADE"
            connection.execute(
                f"CREATE TABLE archive_event_photo (event_id INTEGER NOT NULL REFERENCES archive_event(id){cascade}, photo_id INTEGER NOT NULL REFERENCES photo(id) ON DELETE CASCADE, {primary})"
            )
            connection.execute(
                "CREATE INDEX ix_archive_event_photo_photo_event ON archive_event_photo(photo_id, event_id)"
            )
        elif damage == "constraint":
            connection.execute("PRAGMA writable_schema=ON")
            connection.execute(
                "UPDATE sqlite_master SET sql=replace(sql, ' BETWEEN 1 AND 100', ' >= 0') WHERE name='archive_event'"
            )
        else:
            connection.execute("DROP INDEX ix_archive_event_photo_photo_event")
    _refresh_database_manifest(backup)
    assert not verify_backup(backup).valid
    target = tmp_path / "recovered"
    with pytest.raises(RehearsalError) as failure:
        rehearse_backup(backup, target)
    assert failure.value.stage == "backup verification" and not target.exists()
