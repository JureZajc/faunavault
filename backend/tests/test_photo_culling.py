from __future__ import annotations

import csv
import json
import sqlite3
from datetime import datetime

import pytest
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlmodel import Session, select

from app.archive_export.service import create_metadata_export
from app.archive_integrity import (
    ArchiveIntegrityError,
    inspect_database,
    read_photo_signature,
)
from app.backup.rehearsal import rehearse_backup
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.migrations import run_migrations
from app.models import ClassificationJob, Photo
from tests.test_catalog import add_photo, add_taxon
from tests.test_catalog import catalog_app as catalog_app
from tests.test_photo_curation import patch
from tests.test_photo_lifecycle import jpeg_bytes, upload
from tests.test_photo_lifecycle import lifecycle as lifecycle


def test_culling_default_edits_independence_review_and_trash(lifecycle):
    client, engine, _ = lifecycle
    photo = upload(client).json()
    assert photo["culling_state"] is None
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        stored.status = "needs_review"
        stored.reviewed_at = datetime(2026, 1, 1)
        stored.is_favorite = True
        stored.rating = 5
        session.commit()
    photo = client.get(f"/photos/{photo['id']}").json()
    original = photo
    for state in ("pick", "reject", None):
        saved = patch(client, photo, culling_state=state)
        assert saved.status_code == 200, saved.text
        saved = saved.json()
        assert saved["culling_state"] == state
        assert saved["is_favorite"] and saved["rating"] == 5
        assert saved["status"] == "needs_review"
        assert saved["reviewed_at"] == original["reviewed_at"]
        assert patch(client, saved, culling_state=state).json() == saved
        photo = saved
    assert patch(client, original, culling_state="pick").status_code == 409
    photo = patch(client, photo, culling_state="reject").json()
    assert client.get("/catalog/photos").json()["total"] == 1
    with Session(engine) as session:
        assert session.exec(select(ClassificationJob)).all() == []
    assert client.delete(f"/photos/{photo['id']}").status_code == 200
    assert client.get("/trash/photos").json()["items"][0]["culling_state"] == "reject"
    assert client.post(f"/trash/photos/{photo['id']}/restore").status_code == 200
    restored = client.get(f"/photos/{photo['id']}").json()
    assert restored["culling_state"] == "reject"
    restored = patch(client, restored, is_favorite=False, rating=3).json()
    assert restored["culling_state"] == "reject"


@pytest.mark.parametrize("state", ["undecided", "Pick", "", "trash", True, 1, [], {}])
def test_invalid_culling_never_mutates(lifecycle, state):
    client, _, _ = lifecycle
    photo = upload(client).json()
    assert patch(client, photo, culling_state=state).status_code == 422
    assert client.get(f"/photos/{photo['id']}").json() == photo


def test_culling_filters_smart_queries_and_count_paths(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Vulpes vulpes")
        for i, state in enumerate(("pick", "reject", None, "pick"), 1):
            add_photo(
                session,
                i,
                culling_state=state,
                is_favorite=True,
                rating=5,
                description="wildlife",
                taxon=taxon,
                captured_at=datetime(2026, 6, 1),
                category="bird",
            )
        add_photo(session, 5, culling_state="pick", deleted_at=datetime(2026, 1, 1))
        session.commit()
        taxon_id = taxon.id
    for state, expected in (("pick", [4, 1]), ("reject", [2]), ("undecided", [3])):
        for extra in (
            {},
            {"search": "wildlife"},
            {"taxon_id": taxon_id},
            {
                "search": "wildlife",
                "taxon_id": taxon_id,
                "favorites_only": True,
                "rating": 5,
                "category": "bird",
                "taken_from": "2026-01-01",
                "taken_to": "2026-12-31",
            },
        ):
            query = {"culling_state": state, **extra}
            direct = client.get("/catalog/photos", params=query).json()
            assert direct["total"] == len(expected)
            assert [photo["id"] for photo in direct["items"]] == expected
            created = client.post(
                "/smart-collections",
                json={
                    "name": f"{state} {','.join(extra)}",
                    "query_version": 1,
                    "query": query,
                },
            )
            assert created.status_code == 201, created.text
            smart = client.get(
                f"/smart-collections/{created.json()['id']}/photos"
            ).json()
            assert smart == direct
    assert (
        client.get("/catalog/photos", params={"search": "picked"}).json()["total"] == 0
    )
    for route in ("/catalog/photos", "/catalog/culling", "/catalog/map"):
        assert client.get(route, params={"culling_state": "invalid"}).status_code == 422
    assert (
        client.get("/catalog/map", params={"culling_state": "pick"}).status_code == 422
    )
    assert (
        client.post(
            "/smart-collections",
            json={
                "name": "Invalid",
                "query_version": 1,
                "query": {"culling_state": "invalid"},
            },
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "sort",
    [
        "created_at",
        "captured_at",
        "name",
        "species",
        "confidence",
        "rating",
        "needs_review",
        "pending",
    ],
)
@pytest.mark.parametrize("order", ["asc", "desc"])
def test_culling_neighbors_match_catalog_order_with_ties_and_nulls(
    catalog_app, sort, order
):
    client, engine = catalog_app
    with Session(engine) as session:
        for i in range(1, 7):
            add_photo(
                session,
                i,
                created_at=datetime(2026, 1, 1),
                captured_at=None if i % 2 else datetime(2026, 6, 1),
                rating=None if i % 2 else 3,
                confidence=None if i % 2 else 0.8,
                display_title="Fox",
                species_guess="Vulpes vulpes",
                status="needs_review" if i % 2 else "pending",
            )
        add_photo(session, 7, deleted_at=datetime(2026, 1, 1))
        session.commit()
    query = {"sort": sort, "order": order, "culling_state": "undecided"}
    ids = [
        photo["id"]
        for photo in client.get("/catalog/photos", params=query).json()["items"]
    ]
    for position, photo_id in enumerate(ids):
        result = client.get("/catalog/culling", params={**query, "photo_id": photo_id})
        assert result.status_code == 200, result.text
        body = result.json()
        assert body["photo"]["id"] == photo_id and body["total"] == len(ids)
        assert body["position"] == position + 1 and body["matches_query"]
        assert body["previous_photo_id"] == (ids[position - 1] if position else None)
        assert body["next_photo_id"] == (
            ids[position + 1] if position < len(ids) - 1 else None
        )


def test_culling_anchor_membership_empty_and_unavailable(catalog_app):
    client, engine = catalog_app
    assert client.get("/catalog/culling").json()["photo"] is None
    with Session(engine) as session:
        for i in (1, 2, 3):
            add_photo(session, i, category="bird")
        session.commit()
    query = {"culling_state": "undecided", "category": "bird"}
    first = client.get("/catalog/culling", params=query).json()
    assert first["photo"]["id"] == 3
    patch(client, first["photo"], culling_state="pick")
    anchor = client.get("/catalog/culling", params={**query, "photo_id": 3}).json()
    assert anchor["photo"]["culling_state"] == "pick"
    assert anchor["total"] == 2 and anchor["position"] is None
    assert not anchor["matches_query"] and not anchor["requested_photo_unavailable"]
    assert anchor["next_photo_id"] == 2
    assert client.get("/catalog/culling").json()["total"] == 3
    unavailable = client.get(
        "/catalog/culling", params={**query, "photo_id": 999}
    ).json()
    assert (
        unavailable["requested_photo_unavailable"] and unavailable["photo"]["id"] == 2
    )
    assert (
        client.get(
            "/catalog/culling", params={**query, "category": "mammal", "photo_id": 3}
        ).json()["photo"]
        is None
    )
    client.delete("/photos/3")
    assert client.get("/catalog/culling", params={**query, "photo_id": 3}).json()[
        "requested_photo_unavailable"
    ]


@pytest.mark.parametrize("state", ["pick", "reject", None])
def test_bulk_culling_is_explicit_atomic_independent(catalog_app, state, monkeypatch):
    client, engine = catalog_app
    with Session(engine) as session:
        for i in (1, 2, 3):
            add_photo(
                session,
                i,
                culling_state="reject",
                is_favorite=True,
                rating=5,
                status="needs_review",
            )
        add_photo(session, 4, deleted_at=datetime(2026, 1, 1))
        session.commit()
    before = [client.get(f"/photos/{i}").json() for i in (1, 2, 3)]
    values = (
        {"operation": "clear_culling_state"}
        if state is None
        else {"operation": "set_culling_state", "culling_state": state}
    )
    for ids, expected in (
        ([], 422),
        ([1, 1], 422),
        ([1, 999], 404),
        ([1, 4], 409),
        (list(range(1, 252)), 413),
    ):
        assert (
            client.post("/photos/bulk", json={**values, "photo_ids": ids}).status_code
            == expected
        )

    def fail(_session):
        raise SQLAlchemyError("injected commit failure")

    with monkeypatch.context() as patcher:
        patcher.setattr(Session, "commit", fail)
        assert (
            client.post(
                "/photos/bulk", json={**values, "photo_ids": [1, 2]}
            ).status_code
            == 500
        )
    assert [client.get(f"/photos/{i}").json() for i in (1, 2, 3)] == before
    assert (
        client.post("/photos/bulk", json={**values, "photo_ids": [1, 2]}).status_code
        == 200
    )
    for i in (1, 2):
        saved = client.get(f"/photos/{i}").json()
        assert (
            saved["culling_state"] == state
            and saved["is_favorite"]
            and saved["rating"] == 5
        )
        assert saved["status"] == "needs_review" and saved["reviewed_at"] is None
    assert client.get("/photos/3").json() == before[2]
    assert (
        client.post(
            "/photos/bulk",
            json={
                "operation": "set_culling_state",
                "culling_state": "undecided",
                "photo_ids": [1],
            },
        ).status_code
        == 422
    )


def test_schema17_migration_retry_and_metadata_preservation(lifecycle, monkeypatch):
    client, engine, settings = lifecycle
    photo = patch(client, upload(client).json(), is_favorite=True, rating=3).json()
    with engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM schema_migration WHERE version>=17")
        connection.exec_driver_sql("ALTER TABLE photo DROP COLUMN culling_state")
    assert inspect_database(settings.database_path, 16).migrations[-1] == 16
    import app.migrations as migrations

    def fail(_connection):
        raise RuntimeError("injected migration17 failure")

    with monkeypatch.context() as patcher:
        patcher.setattr(migrations, "_migration_17", fail)
        with pytest.raises(RuntimeError, match="migration17"):
            run_migrations(engine, settings)
    assert run_migrations(engine, settings) == [17, 18, 19]
    assert run_migrations(engine, settings) == []
    assert client.get(f"/photos/{photo['id']}").json() == photo
    assert inspect_database(settings.database_path, 19).photos[0].culling_state is None


@pytest.mark.parametrize(
    "definition",
    [None, "INTEGER", "VARCHAR NOT NULL DEFAULT 'pick'", "VARCHAR DEFAULT 'pick'"],
)
@pytest.mark.parametrize("empty", [True, False])
def test_schema17_verifies_column_structure(lifecycle, definition, empty):
    client, engine, settings = lifecycle
    if not empty:
        upload(client)
    with engine.begin() as connection:
        connection.exec_driver_sql("ALTER TABLE photo DROP COLUMN culling_state")
        if definition:
            connection.exec_driver_sql(
                f"ALTER TABLE photo ADD COLUMN culling_state {definition}"
            )
    with pytest.raises(ArchiveIntegrityError, match="culling_state"):
        inspect_database(settings.database_path, 19)


def test_schema17_constraints_and_corruption(lifecycle):
    client, engine, settings = lifecycle
    upload(client)
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.exec_driver_sql("UPDATE photo SET culling_state='invalid'")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        connection.exec_driver_sql("UPDATE photo SET culling_state='invalid'")
    with pytest.raises(ArchiveIntegrityError):
        inspect_database(settings.database_path, 19)


def test_culling_export_backup_rehearsal_and_live_changes(lifecycle, tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("culling-artifacts")
    client, _, settings = lifecycle

    def add(color, name):
        response = client.post(
            "/photos/upload",
            files={"file": (name, jpeg_bytes(color), "image/jpeg")},
            data={"allow_visual_duplicate": "true"},
        )
        assert response.status_code == 200, response.text
        return response.json()

    first = add("red", "first.jpg")
    second = add("blue", "second.jpg")
    add("green", "third.jpg")
    signature = read_photo_signature(settings.database_path)
    patch(client, first, culling_state="pick")
    patch(client, second, culling_state="reject")
    assert signature != read_photo_signature(settings.database_path)
    client.delete(f"/photos/{second['id']}")
    client.post(
        "/smart-collections",
        json={"name": "Picks", "query_version": 1, "query": {"culling_state": "pick"}},
    )
    exported = create_metadata_export(tmp_path / "export", settings, include_csv=True)
    payload = json.loads(exported.json_path.read_text())
    assert (
        payload["format_version"] == 10
        and payload["source_database_schema_version"] == 19
    )
    assert [photo["culling_state"] for photo in payload["photos"]] == [
        "pick",
        "reject",
        None,
    ]
    assert payload["smart_collections"][0]["query"]["culling_state"] == "pick"
    with exported.csv_path.open(encoding="utf-8", newline="") as stream:
        assert [row["culling_state"] for row in csv.DictReader(stream)] == [
            "pick",
            "reject",
            r"\N",
        ]
    repeated = create_metadata_export(tmp_path / "export2", settings, include_csv=True)
    assert repeated.json_path.read_bytes() == exported.json_path.read_bytes()
    assert repeated.csv_path.read_bytes() == exported.csv_path.read_bytes()
    (tmp_path / "backups").mkdir()
    backup, verification = create_backup(tmp_path / "backups", settings)
    assert verification.valid and verify_backup(backup).valid
    result = rehearse_backup(backup, tmp_path / "recovered")
    assert result.source_schema_version == result.current_schema_version == 19
    with sqlite3.connect(tmp_path / "recovered/data/faunavault.db") as connection:
        assert connection.execute(
            "SELECT culling_state FROM photo ORDER BY id"
        ).fetchall() == [("pick",), ("reject",), (None,)]

    def change():
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("UPDATE photo SET culling_state='reject' WHERE id=1")

    with pytest.raises(ArchiveIntegrityError, match="changed"):
        create_backup(tmp_path / "backups", settings, before_publish=change)
