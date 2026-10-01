from __future__ import annotations

import asyncio
import csv
import json
import sqlite3
from io import BytesIO
from uuid import uuid4

import httpx
import pytest
from PIL import Image
from pydantic import ValidationError
from sqlalchemy import event
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select

from app import main
from app.archive_export.schema import ArchiveMetadataExport
from app.archive_export.service import create_metadata_export
from app.archive_integrity import (
    ArchiveIntegrityError,
    inspect_database,
    read_import_session_signature,
)
from app.backup.rehearsal import rehearse_backup
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.cli import import_photos
from app.config import Settings
from app.database import create_database_engine
from app.migrations import run_migrations
from app.models import Animal, ImportSession, Photo, Taxon
from app.services.import_sessions import start_import_session
from tests.test_folder_import import archive, jpeg, photos, run
from tests.test_photo_lifecycle import jpeg_bytes, lifecycle
from tests.test_restore_rehearsal import _intermediate_backup

__all__ = ["archive", "lifecycle"]

ZERO = dict(
    duplicate_count=0,
    visual_duplicate_skipped_count=0,
    unsupported_count=0,
    failed_count=0,
)


def start(client, identity=None):
    identity = identity or str(uuid4())
    response = client.post("/import-sessions", json={"id": identity})
    assert response.status_code == 200, response.text
    assert response.json()["id"] == identity
    return identity


def upload(client, identity, color="red", **data):
    return client.post(
        "/photos/upload",
        files={"file": (f"{color}.jpg", jpeg_bytes(color), "image/jpeg")},
        data={"import_session_id": identity, "allow_visual_duplicate": "true", **data},
    )


def finish(client, identity, **outcomes):
    response = client.post(
        f"/import-sessions/{identity}/complete", json={**ZERO, **outcomes}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_browser_identity_outcomes_retries_and_completion(lifecycle):
    client, engine, _ = lifecycle
    identity = start(client)
    first = upload(client, identity).json()
    second = upload(client, identity, "blue").json()
    assert first["import_session_id"] == second["import_session_id"] == identity
    original = finish(client, identity, failed_count=1)
    assert original["imported_count"] == original["active_count"] == 2
    assert (
        finish(client, identity, failed_count=1)["completed_at"]
        == original["completed_at"]
    )
    assert upload(client, identity, "green").status_code == 409
    start(client, identity)
    reopened = client.get(f"/import-sessions/{identity}").json()
    assert reopened["started_at"] == original["started_at"]
    assert reopened["completed_at"] is None and reopened["failed_count"] is None
    assert upload(client, identity, "green").status_code == 200
    assert finish(client, identity)["imported_count"] == 3
    other = start(client)
    duplicate = upload(client, other)
    assert (
        duplicate.status_code == 409
        and duplicate.json()["detail"]["code"] == "duplicate_photo"
    )
    assert finish(client, other, duplicate_count=1)["imported_count"] == 0
    with Session(engine) as session:
        assert session.get(Photo, first["id"]).import_session_id == identity


def test_simultaneous_browser_batches_have_isolated_identities(lifecycle):
    client, _, _ = lifecycle
    identities = [start(client), start(client)]

    async def concurrent_uploads():
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as api:
            return await asyncio.gather(
                *[
                    api.post(
                        "/photos/upload",
                        files={
                            "file": (f"{color}.jpg", jpeg_bytes(color), "image/jpeg")
                        },
                        data={
                            "import_session_id": identity,
                            "allow_visual_duplicate": "true",
                        },
                    )
                    for identity, color in zip(identities, ("red", "blue"), strict=True)
                ]
            )

    responses = asyncio.run(concurrent_uploads())
    assert [response.status_code for response in responses] == [200, 200]
    assert [
        response.json()["import_session_id"] for response in responses
    ] == identities
    assert [finish(client, identity)["imported_count"] for identity in identities] == [
        1,
        1,
    ]


def test_standalone_and_compatibility_batch_sessions(lifecycle):
    client, _, _ = lifecycle
    first = client.post(
        "/photos/upload", files={"file": ("one.jpg", jpeg_bytes("red"), "image/jpeg")}
    ).json()
    batch = client.post(
        "/photos/upload-batch",
        files=[
            ("files", ("blue.jpg", jpeg(1), "image/jpeg")),
            ("files", ("invalid.jpg", b"corrupt", "image/jpeg")),
        ],
    ).json()
    identity = batch["import_session_id"]
    assert first["import_session_id"] != identity
    assert [item["import_session_id"] for item in batch["uploaded"]] == [identity]
    item = client.get(f"/import-sessions/{identity}").json()
    assert (
        item["imported_count"] == 1
        and item["failed_count"] == 1
        and item["completed_at"]
    )


def test_visual_duplicate_review_only_successful_photos_join(lifecycle):
    client, _, _ = lifecycle
    original = start(client)
    upload(client, original)
    finish(client, original)
    identity = start(client)
    output = BytesIO()
    Image.open(BytesIO(jpeg_bytes("red"))).save(output, format="JPEG", quality=45)
    payload = output.getvalue()
    skipped = client.post(
        "/photos/upload",
        files={"file": ("near.jpg", payload, "image/jpeg")},
        data={"import_session_id": identity},
    )
    assert (
        skipped.status_code == 409
        and skipped.json()["detail"]["code"] == "possible_visual_duplicate"
    )
    assert client.get(f"/import-sessions/{identity}").json()["imported_count"] == 0
    kept = client.post(
        "/photos/upload",
        files={"file": ("near.jpg", payload, "image/jpeg")},
        data={"import_session_id": identity, "allow_visual_duplicate": "true"},
    )
    assert kept.status_code == 200 and kept.json()["import_session_id"] == identity
    assert finish(client, identity)["imported_count"] == 1


def test_failed_and_unsupported_files_and_invalid_identity(lifecycle):
    client, _, _ = lifecycle
    identity = start(client)
    assert (
        client.post(
            "/photos/upload",
            files={"file": ("invalid.jpg", b"bad", "image/jpeg")},
            data={"import_session_id": identity},
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/photos/upload",
            files={"file": ("notes.txt", b"bad", "text/plain")},
            data={"import_session_id": identity},
        ).status_code
        == 415
    )
    assert upload(client, str(uuid4())).status_code == 404
    assert upload(client, "bad").status_code == 422
    assert (
        finish(client, identity, unsupported_count=1, failed_count=1)["active_count"]
        == 0
    )
    assert (
        client.patch("/photos/1", json={"import_session_id": identity}).status_code
        == 422
    )
    assert (
        client.post(
            f"/import-sessions/{identity}/complete", json={**ZERO, "failed_count": -1}
        ).status_code
        == 422
    )


def test_wrong_source_rejected_before_files_and_creation_rollback(
    lifecycle, monkeypatch
):
    client, engine, settings = lifecycle
    with Session(engine) as session:
        folder = start_import_session(session, "folder_import").id
    assert upload(client, folder).status_code == 409
    assert client.post("/import-sessions", json={"id": folder}).status_code == 409
    assert all(not any(path.iterdir()) for path in settings.image_dirs.values())
    identity = start(client)
    original = Session.commit
    failed = False

    def fail_photo_commit(session):
        nonlocal failed
        if not failed and any(
            isinstance(item, Photo) for item in session.identity_map.values()
        ):
            failed = True
            raise SQLAlchemyError("simulated commit failure")
        return original(session)

    monkeypatch.setattr(Session, "commit", fail_photo_commit)
    assert upload(client, identity).status_code == 500
    item = client.get(f"/import-sessions/{identity}").json()
    assert item["imported_count"] == item["active_count"] == 0
    assert all(not any(path.iterdir()) for path in settings.image_dirs.values())
    assert upload(client, identity).status_code == 200
    assert finish(client, identity)["imported_count"] == 1


def test_compatibility_pending_review_retains_reference(lifecycle):
    client, _, _ = lifecycle
    identity = start(client)
    upload(client, identity)
    finish(client, identity)
    output = BytesIO()
    Image.open(BytesIO(jpeg_bytes("red"))).save(output, format="JPEG", quality=45)
    payload = output.getvalue()
    result = client.post(
        "/photos/upload-batch", files=[("files", ("near.jpg", payload, "image/jpeg"))]
    ).json()
    assert len(result["possible_duplicates"]) == 1
    identity = result["import_session_id"]
    assert client.get(f"/import-sessions/{identity}").json()["completed_at"] is None
    kept = client.post(
        "/photos/upload",
        files={"file": ("near.jpg", payload, "image/jpeg")},
        data={"import_session_id": identity, "allow_visual_duplicate": "true"},
    )
    assert kept.json()["import_session_id"] == identity
    assert finish(client, identity)["imported_count"] == 1


def test_catalog_culling_lifecycle_smart_query_and_pagination(lifecycle):
    client, engine, _ = lifecycle
    identity = start(client)
    first = upload(client, identity).json()
    second = upload(client, identity, "blue").json()
    other = start(client)
    upload(client, other, "green")
    finish(client, identity)
    query = {"import_session_id": identity, "page_size": 1}
    page = client.get("/catalog/photos", params=query).json()
    assert page["total"] == 2 and len(page["items"]) == 1
    assert (
        client.get("/catalog/photos", params={**query, "page": 2}).json()["items"][0][
            "id"
        ]
        != page["items"][0]["id"]
    )
    assert (
        client.get("/catalog/photos", params={**query, "search": "green"}).json()[
            "total"
        ]
        == 0
    )
    assert (
        client.get("/catalog/photos", params={**query, "search": "red"}).json()["total"]
        == 1
    )
    with Session(engine) as session:
        taxon = Taxon(
            external_taxon_id="1",
            scientific_name="Test animal",
            canonical_name="Test animal",
            taxonomic_rank="SPECIES",
        )
        session.add(taxon)
        session.flush()
        for photo in session.exec(select(Photo)).all():
            animal = session.get(Animal, photo.animal_id)
            animal.taxon_id = taxon.id
            session.add(animal)
        session.commit()
        taxon_id = taxon.id
    assert (
        client.get("/catalog/photos", params={**query, "taxon_id": taxon_id}).json()[
            "total"
        ]
        == 2
    )
    assert (
        client.get(
            "/catalog/photos", params={**query, "taxon_id": taxon_id, "search": "green"}
        ).json()["total"]
        == 0
    )
    workspace = client.get(
        "/catalog/culling", params={"import_session_id": identity}
    ).json()
    assert workspace["total"] == 2 and workspace["photo"]["id"] in {
        first["id"],
        second["id"],
    }
    saved = client.patch(
        f"/photos/{first['id']}",
        params={"expected_updated_at": first["updated_at"]},
        json={"culling_state": "reject", "is_favorite": True, "rating": 4},
    )
    assert saved.json()["import_session_id"] == identity
    assert client.get(f"/import-sessions/{identity}").json()["reject_count"] == 1
    smart = client.post(
        "/smart-collections",
        json={
            "name": "This import",
            "query_version": 1,
            "query": {"import_session_id": identity},
        },
    ).json()
    assert smart["query"]["import_session_id"] == identity
    assert client.get(f"/smart-collections/{smart['id']}/photos").json()["total"] == 2
    assert (
        client.get("/catalog/map", params={"import_session_id": identity}).status_code
        == 422
    )
    client.delete(f"/photos/{first['id']}")
    detail = client.get(f"/import-sessions/{identity}").json()
    assert (
        detail["active_count"],
        detail["trash_count"],
        detail["reject_count"],
        detail["imported_count"],
    ) == (1, 1, 0, 2)
    assert client.get("/catalog/photos", params=query).json()["total"] == 1
    client.post(f"/trash/photos/{first['id']}/restore")
    assert client.get("/catalog/photos", params=query).json()["total"] == 2
    for photo in (first, second):
        client.delete(f"/photos/{photo['id']}")
        client.delete(f"/trash/photos/{photo['id']}")
    empty = client.get(f"/import-sessions/{identity}").json()
    assert (
        empty["imported_count"] == 2
        and empty["active_count"] == empty["trash_count"] == 0
    )


def test_history_bounded_grouped_counts_order_and_index(lifecycle):
    client, engine, _ = lifecycle
    identities = [start(client) for _ in range(4)]
    with Session(engine) as session:
        items = session.exec(select(ImportSession)).all()
        for item in items:
            item.started_at = items[0].started_at
            session.add(item)
        session.commit()
    statements = []

    def record(_connection, _cursor, statement, *_args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        page = client.get("/import-sessions", params={"page_size": 3}).json()
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert [item["id"] for item in page["items"]] == sorted(identities, reverse=True)[
        :3
    ]
    assert len(statements) == 3 and "GROUP BY" in statements[-1]
    assert client.get("/import-sessions", params={"page_size": 101}).status_code == 422
    with engine.connect() as connection:
        plan = connection.exec_driver_sql(
            "EXPLAIN QUERY PLAN SELECT id FROM photo WHERE import_session_id=?",
            (identities[0],),
        ).fetchall()
    assert "ix_photo_import_session_id" in str(plan)


def test_folder_history_dry_run_privacy_partial_and_jobs(archive, monkeypatch):
    settings, source = archive
    (source / "good.jpg").write_bytes(jpeg(1))
    (source / "bad.jpg").write_bytes(b"corrupt")
    (source / "notes.txt").write_text("unsupported")
    before = settings.database_path.read_bytes()
    assert run(source, settings, dry_run=True).import_session_id is None
    assert settings.database_path.read_bytes() == before
    result = run(source, settings, classify=True)
    rows = read_import_session_signature(settings.database_path)
    assert len(rows) == 1 and rows[0][4] == source.name and rows[0][5] == 1
    assert rows[0][8:] == (1, 1) and str(source) not in str(rows)
    assert photos(settings)[0].import_session_id == result.import_session_id
    assert run(source, settings).import_session_id != result.import_session_id
    original = import_photos._walk

    def interrupted(*args):
        for item in original(*args):
            yield item
            raise KeyboardInterrupt

    monkeypatch.setattr(import_photos, "_walk", interrupted)
    with pytest.raises(KeyboardInterrupt):
        run(source, settings)
    assert any(
        row[3] is None for row in read_import_session_signature(settings.database_path)
    )


def test_interruption_preserves_committed_photo_and_null_summary(archive, monkeypatch):
    settings, source = archive
    (source / "first.jpg").write_bytes(jpeg(1))
    original = import_photos._walk

    def interrupted(*args):
        yield from original(*args)
        raise KeyboardInterrupt

    monkeypatch.setattr(import_photos, "_walk", interrupted)
    with pytest.raises(KeyboardInterrupt):
        run(source, settings, classify=True)
    record = read_import_session_signature(settings.database_path)[0]
    assert record[3] is None and record[5] == 1 and record[6:] == (None,) * 4
    assert photos(settings)[0].import_session_id == record[0]


@pytest.mark.parametrize("damage", ["index", "membership", "total", "label"])
def test_schema18_verification_rejects_damaged_provenance(lifecycle, damage):
    client, _, settings = lifecycle
    identity = start(client)
    upload(client, identity)
    with sqlite3.connect(settings.database_path) as connection:
        if damage == "index":
            connection.execute("DROP INDEX ix_photo_import_session_id")
        elif damage == "membership":
            connection.execute("UPDATE photo SET import_session_id=?", (str(uuid4()),))
        elif damage == "total":
            connection.execute("UPDATE import_session SET imported_count=0")
        else:
            connection.execute(
                "UPDATE import_session SET label='private/parent/folder'"
            )
    with pytest.raises(ArchiveIntegrityError):
        inspect_database(settings.database_path, 19)


def test_backup_export_rehearsal_and_session_only_changes(lifecycle, tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("import-artifacts")
    client, _, settings = lifecycle
    identity = start(client)
    photo = upload(client, identity).json()
    finish(client, identity)
    client.delete(f"/photos/{photo['id']}")
    first = create_metadata_export(tmp_path / "export", settings, include_csv=True)
    second = create_metadata_export(
        tmp_path / "export-again", settings, include_csv=True
    )
    assert first.json_path.read_bytes() == second.json_path.read_bytes()
    assert first.csv_path.read_bytes() == second.csv_path.read_bytes()
    payload = json.loads(first.json_path.read_text())
    assert payload["format_version"] == 10 and payload["counts"]["import_sessions"] == 1
    assert payload["photos"][0]["import_session_id"] == identity
    invalid = json.loads(first.json_path.read_text())
    invalid["photos"][0]["import_session_id"] = str(uuid4())
    with pytest.raises(ValidationError, match="absent from the export"):
        ArchiveMetadataExport.model_validate(invalid)
    with first.csv_path.open(newline="", encoding="utf-8") as stream:
        assert next(csv.DictReader(stream))["import_session_id"] == identity
    (tmp_path / "backups").mkdir()
    backup, verification = create_backup(tmp_path / "backups", settings)
    assert verification.valid and verify_backup(backup).valid
    recovered = tmp_path / "recovered"
    result = rehearse_backup(backup, recovered)
    assert result.current_schema_version == result.source_schema_version == 19
    assert read_import_session_signature(
        recovered / "data/faunavault.db"
    ) == read_import_session_signature(settings.database_path)

    def change():
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("UPDATE import_session SET label='changed'")

    with pytest.raises(ArchiveIntegrityError, match="Import Session.*changed"):
        create_backup(tmp_path / "backups", settings, before_publish=change)


def test_schema18_migration_and_legacy_provenance(tmp_path, monkeypatch):
    backup = _intermediate_backup(tmp_path, monkeypatch, 17)
    database = backup / "database/faunavault.db"
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite:///{database}",
        image_dir=backup / "images",
    )
    engine = create_database_engine(settings)
    assert inspect_database(settings.database_path, 17).migrations[-1] == 17
    assert run_migrations(engine, settings) == [18, 19]
    assert run_migrations(engine, settings) == []
    assert all(
        photo.import_session_id is None
        for photo in inspect_database(settings.database_path, 19).photos
    )
    assert read_import_session_signature(database) == ()
    engine.dispose()
