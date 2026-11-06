from __future__ import annotations

# ruff: noqa: F811
import json
import sqlite3
from datetime import datetime

import pytest
from pydantic import ValidationError
from sqlmodel import Session, select

from app.archive_export.schema import ArchiveMetadataExport
from app.archive_export.service import create_metadata_export
from app.archive_integrity import (
    ArchiveIntegrityError,
    inspect_database,
    read_photo_signature,
    read_sighting_signature,
)
from app.backup.manifest import DATABASE_BACKUP_PATH
from app.backup.rehearsal import rehearse_backup
from app.backup.service import create_backup
from app.backup.verify import verify_backup
from app.migrations import run_migrations
from app.models import Photo, SightingPhoto, Taxon
from tests.test_catalog import add_taxon
from tests.test_collections import collections_app, seed_photos  # noqa: F401
from tests.test_photo_lifecycle import jpeg_bytes, lifecycle, upload  # noqa: F401
from tests.test_restore_rehearsal import _refresh_database_manifest

OBSERVED = "2026-08-23T22:30:05.123456"


def create(client, ids, **fields):
    response = client.post(
        "/sightings",
        json={
            "photo_ids": ids,
            "observed_at": OBSERVED,
            **fields,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_crud_local_taxonomy_and_shared_photo(collections_app):
    client, engine, _ = collections_app
    first, second, third = seed_photos(engine, count=3)
    with Session(engine) as session:
        fox = add_taxon(session, "Vulpes vulpes", "Red fox")
        genus = add_taxon(session, "Vulpes")
        genus.taxonomic_rank = "GENUS"
        fox_id, genus_id = fox.id, genus.id
        session.commit()
    before = client.get(f"/photos/{first}").json()
    item = create(
        client,
        [first, second],
        subject_label="  Fox in meadow  ",
        taxon_id=fox_id,
        latitude=0,
        longitude=0,
        observed_at_offset_minutes=0,
        location_label="  Meadow ",
        notes=" first\nsecond ",
    )
    other = create(client, [first])
    url = f"/sightings/{item['id']}"
    assert item["subject_label"] == "Fox in meadow" and item["notes"] == "first\nsecond"
    assert item["observed_at"] == OBSERVED and item["observed_at_offset_minutes"] == 0
    assert (
        item["latitude"] == item["longitude"] == 0
        and item["location_label"] == "Meadow"
    )
    assert item["taxon"]["scientific_name"] == "Vulpes vulpes"
    assert other["taxon"] is None and other["subject_label"] is None
    assert client.get(url).json() == item
    assert client.get("/sightings/taxa", params={"search": "RED"}).json()["items"] == [
        item["taxon"]
    ]
    assert client.get("/sightings/taxa", params={"search": "%"}).json()["items"] == []
    assert client.patch(url, json={"taxon_id": genus_id}).status_code == 422
    assert client.patch(url, json={"taxon_id": 99999}).status_code == 404
    assert client.patch(url, json={"longitude": None}).status_code == 422
    updated = client.patch(
        url, json={"taxon_id": None, "latitude": None, "longitude": None, "notes": None}
    ).json()
    assert (
        updated["taxon"]
        is updated["latitude"]
        is updated["longitude"]
        is updated["notes"]
        is None
    )
    assert (
        updated["created_at"] == item["created_at"]
        and updated["updated_at"] > item["updated_at"]
    )
    links = client.get(
        f"/photos/{first}/sightings", params={"page_size": 1, "page": 2}
    ).json()
    assert links["total"] == 2 and links["items"][0]["id"] == item["id"]
    added = client.post(f"{url}/photos", json={"photo_ids": [first, third]})
    assert added.json()["active_photo_count"] == 3
    assert (
        client.get(f"{url}/photos", params={"page_size": 1, "page": 2}).json()["items"][
            0
        ]["id"]
        == second
    )
    removed = client.request(
        "DELETE", f"{url}/photos", json={"photo_ids": [first, second, third]}
    )
    assert removed.json()["active_photo_count"] == 0
    assert client.get(f"{url}/photos").json()["total"] == 0
    assert client.get(f"/photos/{first}/sightings").json()["total"] == 1
    assert client.get(f"/photos/{first}").json() == before
    assert client.delete(url).json() == {"status": "deleted", "sighting_id": item["id"]}
    assert client.get(url).status_code == client.delete(url).status_code == 404
    assert client.get(f"/sightings/{other['id']}").json()["active_photo_count"] == 1
    assert client.delete(f"/sightings/{other['id']}").status_code == 200
    assert client.get(f"/photos/{first}").json() == before
    with Session(engine) as session:
        assert session.exec(select(SightingPhoto)).all() == []
        assert session.get(Taxon, fox_id).common_name == "Red fox"


@pytest.mark.parametrize(
    ("changes", "status"),
    [
        ({"observed_at": None}, 422),
        ({"observed_at": "2026-08-23"}, 422),
        ({"observed_at": "2026-02-30T10:00"}, 422),
        ({"observed_at": "2026-08-23T12:00Z"}, 422),
        ({"observed_at": 0}, 422),
        ({"observed_at_offset_minutes": 1440}, 422),
        ({"observed_at_offset_minutes": True}, 422),
        ({"latitude": 0}, 422),
        ({"latitude": 91, "longitude": 0}, 422),
        ({"latitude": 0, "longitude": -181}, 422),
        ({"latitude": "0", "longitude": 0}, 422),
        ({"notes": "x" * 2001}, 422),
        ({"subject_label": "x" * 101}, 422),
        ({"location_label": "x" * 201}, 422),
        ({"taxon_id": 0}, 422),
        ({"taxon_id": "1"}, 422),
        ({"taxon_id": 99999}, 404),
        ({"photo_ids": []}, 422),
        ({"photo_ids": [1, 1]}, 422),
        ({"photo_ids": [True]}, 422),
        ({"photo_ids": [2**63]}, 422),
        ({"photo_ids": [1, 99999]}, 404),
        ({"photo_ids": [1, 2]}, 409),
        ({"photo_ids": list(range(1, 252))}, 422),
    ],
)
def test_invalid_create_is_atomic(collections_app, changes, status):
    client, engine, _ = collections_app
    seed_photos(engine, count=2, trashed={2})
    assert (
        client.post(
            "/sightings", json={"observed_at": OBSERVED, "photo_ids": [1], **changes}
        ).status_code
        == status
    )
    assert client.get("/sightings").json()["total"] == 0


def test_required_fields_and_membership_limits(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=250)
    assert client.post("/sightings", json={"photo_ids": ids}).status_code == 422
    assert client.post("/sightings", json={"observed_at": OBSERVED}).status_code == 422
    item = create(client, ids)
    url = f"/sightings/{item['id']}"
    assert item["active_photo_count"] == 250 and item["preview"]["id"] == ids[0]
    assert client.get(f"{url}/photos").json()["total_pages"] == 11
    assert client.get(f"{url}/photos?page_size=101").status_code == 422
    assert client.get("/sightings/0").status_code == 422
    assert client.patch(url, json={}).status_code == 422
    assert client.patch(url, json={"observed_at": None}).status_code == 422
    assert (
        client.post(f"{url}/photos", json={"photo_ids": [ids[0], 999999]}).status_code
        == 404
    )


def test_creation_rolls_back_after_membership_insert_error(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=2)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            f"CREATE TRIGGER fail_membership BEFORE INSERT ON sighting_photo WHEN NEW.photo_id = {ids[1]} "
            "BEGIN SELECT RAISE(ABORT, 'injected membership failure'); END"
        )
    assert (
        client.post(
            "/sightings", json={"observed_at": OBSERVED, "photo_ids": ids}
        ).status_code
        == 500
    )
    assert client.get("/sightings").json()["total"] == 0
    with Session(engine) as session:
        assert session.exec(select(SightingPhoto)).all() == []
        assert len(session.exec(select(Photo)).all()) == 2


def test_selection_suggests_only_shared_metadata_and_never_import_time(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=3)
    with Session(engine) as session:
        for identity in ids[:2]:
            photo = session.get(Photo, identity)
            photo.captured_at = datetime.fromisoformat(OBSERVED)
            photo.captured_at_offset_minutes = -90 if identity == ids[0] else 60
            photo.latitude = photo.longitude = 0
        session.commit()
    selection = client.post("/sightings/selection", json={"photo_ids": ids[:2]}).json()
    assert (
        selection["observed_at"] == OBSERVED
        and selection["observed_at_offset_minutes"] is None
    )
    assert selection["latitude"] == selection["longitude"] == 0
    assert [photo["id"] for photo in selection["previews"]] == ids[:2]
    selection = client.post("/sightings/selection", json={"photo_ids": ids}).json()
    assert selection["observed_at"] is selection["latitude"] is None
    assert not selection["capture_times_differ"]
    with Session(engine) as session:
        photo = session.get(Photo, ids[2])
        photo.captured_at = datetime(2026, 9, 1, 12)
        photo.latitude, photo.longitude = 1, 2
        session.commit()
    selection = client.post("/sightings/selection", json={"photo_ids": ids}).json()
    assert selection["observed_at"] is selection["longitude"] is None
    assert selection["capture_times_differ"]
    assert client.get("/sightings").json()["total"] == 0


def test_journal_filters_totals_and_tie_order(collections_app):
    client, engine, _ = collections_app
    ids = seed_photos(engine, count=3)
    with Session(engine) as session:
        taxon_id = add_taxon(session, "Vulpes vulpes").id
        session.commit()
    early = create(client, ids, observed_at="2026-08-22T12:00:00")
    first = create(
        client, ids[:2], taxon_id=taxon_id, observed_at="2026-08-23T23:59:59.999999"
    )
    second = create(client, ids[1:], observed_at=first["observed_at"])
    result = client.get("/sightings", params={"page_size": 1, "page": 2}).json()
    assert result["total_pages"] == 3 and result["items"][0]["id"] == first["id"]
    assert result["totals"] == {
        "recorded": 3,
        "in_date_range": 3,
        "verified": 1,
        "unidentified": 2,
    }
    result = client.get("/sightings", params={"sort": "oldest"}).json()
    assert [item["id"] for item in result["items"]] == [
        early["id"],
        first["id"],
        second["id"],
    ]
    result = client.get(
        "/sightings",
        params={
            "date_from": "2026-08-23",
            "date_to": "2026-08-23",
            "taxon_id": taxon_id,
        },
    ).json()
    assert result["total"] == 1 and result["totals"]["in_date_range"] == 2
    assert result["items"][0]["active_photo_count"] == 2
    assert (
        client.get("/sightings?date_from=2026-09-01&date_to=2026-08-01").status_code
        == 422
    )


def test_trash_restore_and_purge_rollback(lifecycle):
    client, engine, settings = lifecycle
    original = jpeg_bytes()
    photo = upload(client, original).json()
    photo_id = photo["id"]
    item = create(client, [photo_id])
    other = create(client, [photo_id])
    url = f"/sightings/{item['id']}"
    path = settings.image_dirs["original"] / photo["stored_filename"]
    assert client.delete(f"/photos/{photo_id}").status_code == 200
    detail = client.get(url).json()
    assert detail["active_photo_count"] == 0 and detail["trash_photo_count"] == 1
    assert (
        detail["preview"] is None and client.get(f"{url}/photos").json()["items"] == []
    )
    assert client.post(f"/trash/photos/{photo_id}/restore").status_code == 200
    assert client.get(f"{url}/photos").json()["items"][0]["id"] == photo_id
    assert client.delete(f"/photos/{photo_id}").status_code == 200
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TRIGGER fail_purge AFTER DELETE ON photo "
            "BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END"
        )
    assert client.delete(f"/trash/photos/{photo_id}").status_code == 500
    assert client.get(url).json()["trash_photo_count"] == 1
    assert path.read_bytes() == original
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TRIGGER fail_purge")
    assert client.delete(f"/trash/photos/{photo_id}").status_code == 200
    assert not path.exists()
    for identity in (item["id"], other["id"]):
        detail = client.get(f"/sightings/{identity}").json()
        assert detail["active_photo_count"] == detail["trash_photo_count"] == 0
    with Session(engine) as session:
        assert session.exec(select(SightingPhoto)).all() == []


def test_migrate_schema_22_without_changing_existing_photos(lifecycle):
    client, engine, settings = lifecycle
    assert upload(client).status_code == 200
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP TABLE sighting_photo")
        connection.exec_driver_sql("DROP TABLE sighting")
        connection.exec_driver_sql("DELETE FROM schema_migration WHERE version = 23")
    before = read_photo_signature(settings.database_path)
    assert inspect_database(settings.database_path, 22).migrations[-1] == 22
    assert run_migrations(engine, settings) == [23]
    assert run_migrations(engine, settings) == []
    assert inspect_database(settings.database_path, 23).sightings == 0
    assert read_photo_signature(settings.database_path) == before
    assert read_sighting_signature(settings.database_path) == ((), ())


def test_export_backup_and_rehearsal_preserve_trash_memberships(
    lifecycle, tmp_path_factory
):
    client, _, settings = lifecycle
    first = upload(client, jpeg_bytes("red"), "first.jpg").json()["id"]
    uploaded = client.post(
        "/photos/upload",
        files={"file": ("second.jpg", jpeg_bytes("blue", (23, 47)), "image/jpeg")},
        data={"allow_visual_duplicate": "true"},
    )
    assert uploaded.status_code == 200, uploaded.text
    second = uploaded.json()["id"]
    with sqlite3.connect(settings.database_path) as connection:
        taxon_id = connection.execute(
            "INSERT INTO taxon (provider, external_taxon_id, scientific_name, canonical_name, "
            "taxonomic_rank, synchronized_at) VALUES ('gbif', '123', 'Vulpes vulpes', "
            "'Vulpes vulpes', 'SPECIES', CURRENT_TIMESTAMP) RETURNING id"
        ).fetchone()[0]
    item = create(
        client,
        [second, first],
        taxon_id=taxon_id,
        latitude=0,
        longitude=0,
        notes="Field note",
    )
    assert client.delete(f"/photos/{second}").status_code == 200
    root = tmp_path_factory.mktemp("sighting-artifacts")
    export = create_metadata_export(root / "export", settings, include_csv=True)
    again = create_metadata_export(root / "again", settings, include_csv=True)
    assert export.json_path.read_bytes() == again.json_path.read_bytes()
    assert export.csv_path.read_bytes() == again.csv_path.read_bytes()
    payload = json.loads(export.json_path.read_bytes())
    assert (
        payload["format_version"] == 15
        and payload["source_database_schema_version"] == 23
    )
    assert payload["sightings"][0]["observed_at"] == OBSERVED
    assert payload["sightings"][0]["notes"] == "Field note"
    assert payload["sightings"][0]["taxon_id"] == taxon_id
    assert (
        payload["counts"]["sightings"] == 1
        and payload["counts"]["sighting_memberships"] == 2
    )
    assert payload["sighting_photos"] == [
        {"sighting_id": item["id"], "photo_id": first},
        {"sighting_id": item["id"], "photo_id": second},
    ]
    payload["sighting_photos"][1]["photo_id"] = 99999
    with pytest.raises(ValidationError, match="Sighting membership references"):
        ArchiveMetadataExport.model_validate(payload)
    (root / "backups").mkdir()
    backup, verification = create_backup(root / "backups", settings)
    assert verification.valid and verification.manifest.counts.sightings == 1
    assert verify_backup(backup).valid
    target = root / "recovered"
    result = rehearse_backup(backup, target)
    assert result.sightings == 1 and result.sighting_memberships == 2
    assert read_sighting_signature(
        target / "data/faunavault.db"
    ) == read_sighting_signature(settings.database_path)

    def change():
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("UPDATE sighting SET notes = 'changed'")

    with pytest.raises(ArchiveIntegrityError, match="Sighting.*changed"):
        create_backup(root / "backups", settings, before_publish=change)

    with sqlite3.connect(backup / DATABASE_BACKUP_PATH) as connection:
        connection.execute(
            "INSERT INTO sighting_photo VALUES (?, 99999)", (item["id"],)
        )
    _refresh_database_manifest(backup)
    corrupted = verify_backup(backup)
    assert not corrupted.valid and any(
        "foreign_key_check" in error for error in corrupted.errors
    )
