from __future__ import annotations

import csv
import json
import sqlite3
from datetime import UTC, datetime

import pytest
from sqlalchemy.exc import IntegrityError
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
from app.services.classification import apply_classification
from tests.test_catalog import add_photo, add_taxon
from tests.test_catalog import catalog_app as catalog_app
from tests.test_photo_lifecycle import lifecycle as lifecycle
from tests.test_photo_lifecycle import upload


def patch(client, photo, **values):
    return client.patch(
        f"/photos/{photo['id']}",
        params={"expected_updated_at": photo["updated_at"]},
        json=values,
    )


@pytest.mark.parametrize("rating", range(1, 6))
def test_curation_independent_strict_edits_and_review_isolation(lifecycle, rating):
    client, engine, _ = lifecycle
    photo = upload(client).json()
    assert photo["is_favorite"] is False and photo["rating"] is None
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        stored.status = "needs_review"
        stored.reviewed_at = datetime(2026, 1, 1, tzinfo=UTC)
        session.commit()
    photo = client.get(f"/photos/{photo['id']}").json()
    review = photo["reviewed_at"]
    rated = patch(client, photo, rating=rating).json()
    assert rated["rating"] == rating and not rated["is_favorite"]
    favorite = patch(client, rated, is_favorite=True).json()
    assert favorite["rating"] == rating and favorite["is_favorite"]
    assert favorite["status"] == "needs_review" and favorite["reviewed_at"] == review
    assert patch(client, photo, rating=rating).status_code == 409
    assert patch(client, favorite, is_favorite=True, rating=rating).json() == favorite
    cleared = patch(client, favorite, rating=None).json()
    assert cleared["is_favorite"] and cleared["rating"] is None
    unfavorite = patch(client, cleared, is_favorite=False).json()
    assert unfavorite["rating"] is None and not unfavorite["is_favorite"]
    assert (
        unfavorite["reviewed_at"] == review and unfavorite["status"] == "needs_review"
    )
    with Session(engine) as session:
        assert session.exec(select(ClassificationJob)).all() == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("rating", value)
        for value in (0, -1, 6, 1.0, 1.5, True, False, "5", "bad", [], {})
    ]
    + [("is_favorite", value) for value in (None, 0, 1, "true", [], {})],
)
def test_invalid_curation_never_changes_photo(lifecycle, field, value):
    client, _, _ = lifecycle
    photo = upload(client).json()
    assert patch(client, photo, **{field: value}).status_code == 422
    assert client.get(f"/photos/{photo['id']}").json() == photo


def test_trash_restore_capture_and_classification_preserve_curation(lifecycle):
    client, engine, _ = lifecycle
    photo = patch(client, upload(client).json(), is_favorite=True, rating=5).json()
    corrected = patch(
        client,
        photo,
        captured_at="2026-01-02T03:04:05",
        captured_at_offset_minutes=None,
    ).json()
    restored = patch(client, corrected, restore_original_metadata=True).json()
    assert restored["is_favorite"] and restored["rating"] == 5
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        # Classification owns only its established classification fields.
        from app.ollama_client import ClassificationResult as Result

        result = Result(
            display_title="Fox",
            common_name="fox",
            species_guess="Vulpes vulpes",
            breed_guess=None,
            category="mammal",
            confidence=0.9,
            description="Fox",
            tags=[],
            is_animal=True,
            needs_review=False,
            model="offline-test",
        )
        apply_classification(stored, result, 0.8)
        session.commit()
    client.delete(f"/photos/{photo['id']}")
    trash = client.get("/trash/photos").json()["items"][0]
    assert trash["is_favorite"] and trash["rating"] == 5
    assert client.post(f"/trash/photos/{photo['id']}/restore").status_code == 200
    restored = client.get(f"/photos/{photo['id']}").json()
    assert restored["is_favorite"] and restored["rating"] == 5


def test_catalog_and_smart_queries_share_curation_and_optimized_counts(catalog_app):
    client, engine = catalog_app
    with Session(engine) as session:
        taxon = add_taxon(session, "Vulpes vulpes")
        photos = [
            add_photo(
                session,
                i,
                rating=rating,
                is_favorite=favorite,
                taxon=taxon,
                category="bird",
                description="wildlife",
                captured_at=datetime(2026, 6, 1),
            )
            for i, (rating, favorite) in enumerate(
                [(5, True), (4, True), (5, False), (None, True), (1, False)], 1
            )
        ]
        add_photo(
            session, 6, rating=5, is_favorite=True, deleted_at=datetime(2026, 1, 1)
        )
        session.commit()
        ids = [p.id for p in photos]
        taxon_id = taxon.id
    scenarios = [
        ({"favorites_only": True}, [ids[3], ids[1], ids[0]]),
        ({"rating": 5}, [ids[2], ids[0]]),
        ({"rating_min": 4}, [ids[2], ids[1], ids[0]]),
        ({"unrated": True}, [ids[3]]),
        (
            {
                "favorites_only": True,
                "rating_min": 4,
                "search": "wildlife",
                "taxon_id": taxon_id,
                "taken_from": "2026-01-01",
                "category": "bird",
            },
            [ids[1], ids[0]],
        ),
    ]
    for scenario, (criteria, expected) in enumerate(scenarios):
        direct = client.get("/catalog/photos", params=criteria).json()
        assert direct["total"] == len(expected)
        assert [p["id"] for p in direct["items"]] == expected
        smart = client.post(
            "/smart-collections",
            json={
                "name": f"Curation {scenario}",
                "query_version": 1,
                "query": criteria,
            },
        )
        assert smart.status_code == 201, smart.text
        assert (
            client.get(f"/smart-collections/{smart.json()['id']}/photos").json()
            == direct
        )
    for direction, expected in [
        ("desc", [ids[2], ids[0], ids[1], ids[4], ids[3]]),
        ("asc", [ids[4], ids[1], ids[2], ids[0], ids[3]]),
    ]:
        result = client.get(
            "/catalog/photos",
            params={"sort": "rating", "order": direction, "page_size": 2},
        ).json()
        all_ids = [p["id"] for p in result["items"]]
        for page in (2, 3):
            all_ids += [
                p["id"]
                for p in client.get(
                    "/catalog/photos",
                    params={
                        "sort": "rating",
                        "order": direction,
                        "page_size": 2,
                        "page": page,
                    },
                ).json()["items"]
            ]
        assert all_ids == expected
    assert (
        client.get("/catalog/photos", params={"search": "favorite"}).json()["total"]
        == 0
    )
    assert (
        client.get("/catalog/photos", params={"search": "five stars"}).json()["total"]
        == 0
    )


@pytest.mark.parametrize(
    "criteria",
    [
        {"rating": 0},
        {"rating_min": 6},
        {"rating": "1.0"},
        {"rating": 5, "rating_min": 4},
        {"rating": 1, "unrated": True},
    ],
)
def test_catalog_rejects_invalid_or_conflicting_ratings(catalog_app, criteria):
    client, _ = catalog_app
    assert client.get("/catalog/photos", params=criteria).status_code == 422
    assert (
        client.post(
            "/smart-collections",
            json={"name": "Invalid", "query_version": 1, "query": criteria},
        ).status_code
        == 422
    )


@pytest.mark.parametrize(
    "criteria",
    [{"favorites_only": True}, {"rating": 5}, {"rating_min": 4}, {"unrated": True}],
)
def test_map_rejects_curation_filters(catalog_app, criteria):
    client, _ = catalog_app
    assert client.get("/catalog/map", params=criteria).status_code == 422


@pytest.mark.parametrize(
    "operation,values,field,expected",
    [
        ("set_favorite", {"is_favorite": True}, "is_favorite", True),
        ("set_favorite", {"is_favorite": False}, "is_favorite", False),
        *[
            ("set_rating", {"rating": rating}, "rating", rating)
            for rating in range(1, 6)
        ],
        ("clear_rating", {}, "rating", None),
    ],
)
def test_bulk_curation_is_bounded_atomic_and_review_independent(
    catalog_app, operation, values, field, expected
):
    client, engine = catalog_app
    with Session(engine) as session:
        photos = [
            add_photo(session, i, status="needs_review", is_favorite=True, rating=3)
            for i in (1, 2, 3)
        ]
        trashed = add_photo(session, 4, deleted_at=datetime(2026, 1, 1))
        session.commit()
        ids = [p.id for p in photos]
        trash_id = trashed.id
    payload = {"operation": operation, "photo_ids": ids[:2], **values}
    before = [client.get(f"/photos/{i}").json() for i in ids]
    assert (
        client.post(
            "/photos/bulk", json={**payload, "photo_ids": [ids[0], 99999]}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/photos/bulk", json={**payload, "photo_ids": [ids[0], trash_id]}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/photos/bulk", json={**payload, "photo_ids": list(range(1, 252))}
        ).status_code
        == 413
    )
    assert [client.get(f"/photos/{i}").json() for i in ids] == before
    response = client.post("/photos/bulk", json=payload)
    assert response.status_code == 200 and response.json()["affected_count"] == 2
    after = [client.get(f"/photos/{i}").json() for i in ids]
    assert after[2] == before[2]
    for photo in after[:2]:
        assert photo[field] == expected
        assert photo["status"] == "needs_review" and photo["reviewed_at"] is None
    assert client.post("/photos/bulk", json=payload).status_code == 200
    assert [client.get(f"/photos/{i}").json() for i in ids] == after


@pytest.mark.parametrize(
    "payload",
    [
        {"operation": "set_rating", "rating": value}
        for value in (None, 0, 6, 1.0, 1.5, True, "5", [])
    ]
    + [
        {"operation": "set_favorite", "is_favorite": value}
        for value in (None, 1, "true")
    ]
    + [
        {"operation": "set_rating"},
        {"operation": "set_favorite"},
        {"operation": "clear_rating", "rating": 1},
    ],
)
def test_bulk_rejects_invalid_curation_before_mutating(catalog_app, payload):
    client, engine = catalog_app
    with Session(engine) as session:
        photo = add_photo(session, 1)
        session.commit()
        photo_id = photo.id
    before = client.get(f"/photos/{photo_id}").json()
    assert (
        client.post(
            "/photos/bulk", json={**payload, "photo_ids": [photo_id]}
        ).status_code
        == 422
    )
    assert client.get(f"/photos/{photo_id}").json() == before


def test_bulk_curation_commit_failure_rolls_back_all_rows(catalog_app, monkeypatch):
    from sqlalchemy.exc import SQLAlchemyError

    client, engine = catalog_app
    with Session(engine) as session:
        photos = [add_photo(session, i) for i in (1, 2)]
        session.commit()
        ids = [photo.id for photo in photos]

    def fail_commit(_session):
        raise SQLAlchemyError("simulated failure")

    with monkeypatch.context() as patcher:
        patcher.setattr(Session, "commit", fail_commit)
        assert (
            client.post(
                "/photos/bulk",
                json={"operation": "set_rating", "rating": 5, "photo_ids": ids},
            ).status_code
            == 500
        )
    assert all(
        client.get(f"/photos/{photo_id}").json()["rating"] is None for photo_id in ids
    )


def test_schema16_export_backup_rehearsal_and_live_signature(
    lifecycle, tmp_path_factory
):
    client, _, settings = lifecycle
    first = upload(client).json()
    before = read_photo_signature(settings.database_path)
    first = patch(client, first, is_favorite=True, rating=5).json()
    assert before != read_photo_signature(settings.database_path)
    client.delete(f"/photos/{first['id']}")
    root = tmp_path_factory.mktemp("curation-artifacts")
    (root / "backups").mkdir()
    backup, verification = create_backup(root / "backups", settings)
    assert verification.valid and verify_backup(backup).valid
    result = rehearse_backup(backup, root / "recovered")
    assert result.source_schema_version == result.current_schema_version == 16
    with sqlite3.connect(root / "recovered/data/faunavault.db") as connection:
        assert connection.execute(
            "SELECT is_favorite, rating FROM photo"
        ).fetchone() == (1, 5)
    exported = create_metadata_export(root / "export", settings, include_csv=True)
    payload = json.loads(exported.json_path.read_text())
    assert (
        payload["format_version"] == 7 and payload["photos"][0]["is_favorite"] is True
    )
    assert payload["photos"][0]["rating"] == 5
    with exported.csv_path.open(newline="", encoding="utf-8") as source:
        row = next(csv.DictReader(source))
    assert row["is_favorite"] == "true" and row["rating"] == "5"
    repeated = create_metadata_export(root / "export2", settings, include_csv=True)
    assert repeated.json_path.read_bytes() == exported.json_path.read_bytes()


def test_migration16_preserves_existing_metadata_and_is_idempotent(lifecycle):
    client, engine, settings = lifecycle
    before = upload(client).json()
    with engine.begin() as connection:
        connection.exec_driver_sql("DELETE FROM schema_migration WHERE version=16")
        connection.exec_driver_sql("ALTER TABLE photo DROP COLUMN is_favorite")
        connection.exec_driver_sql("ALTER TABLE photo DROP COLUMN rating")
    assert inspect_database(settings.database_path, 15).migrations[-1] == 15
    assert run_migrations(engine, settings) == [16]
    assert client.get(f"/photos/{before['id']}").json() == before
    assert run_migrations(engine, settings) == []


@pytest.mark.parametrize("empty", [True, False])
@pytest.mark.parametrize("column", ["is_favorite", "rating"])
def test_schema16_requires_columns_even_when_empty(lifecycle, empty, column):
    client, engine, settings = lifecycle
    if not empty:
        upload(client)
    with engine.begin() as connection:
        connection.exec_driver_sql(f"ALTER TABLE photo DROP COLUMN {column}")
    with pytest.raises(ArchiveIntegrityError):
        inspect_database(settings.database_path, 16)


@pytest.mark.parametrize(
    "column,definition",
    [
        ("is_favorite", "BOOLEAN DEFAULT 0"),
        ("is_favorite", "INTEGER NOT NULL DEFAULT 0"),
        ("is_favorite", "BOOLEAN NOT NULL DEFAULT 1"),
        ("rating", "REAL"),
        ("rating", "INTEGER DEFAULT 1"),
    ],
)
def test_schema16_requires_column_types_defaults_and_nullability(
    lifecycle, column, definition
):
    _, engine, settings = lifecycle
    with engine.begin() as connection:
        connection.exec_driver_sql(f"ALTER TABLE photo DROP COLUMN {column}")
        connection.exec_driver_sql(
            f"ALTER TABLE photo ADD COLUMN {column} {definition}"
        )
    with pytest.raises(ArchiveIntegrityError, match="column structure"):
        inspect_database(settings.database_path, 16)


@pytest.mark.parametrize(
    "changes",
    [
        "rating=0",
        "rating=6",
        "rating=1.5",
        "rating='bad'",
        "is_favorite=2",
        "is_favorite='bad'",
    ],
)
def test_database_constraints_and_inventory_reject_invalid_curation(lifecycle, changes):
    client, engine, settings = lifecycle
    upload(client)
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.exec_driver_sql(f"UPDATE photo SET {changes}")
    with engine.begin() as connection:
        connection.exec_driver_sql("PRAGMA ignore_check_constraints=ON")
        connection.exec_driver_sql(f"UPDATE photo SET {changes}")
    with pytest.raises(ArchiveIntegrityError):
        inspect_database(settings.database_path, 16)
