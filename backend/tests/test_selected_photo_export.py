from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime
from io import BytesIO
from zipfile import ZipFile

import pytest
from PIL import Image
from sqlmodel import Session
from starlette.requests import ClientDisconnect

import app.services.selected_photo_export as service
from app.models import Animal, Photo, Taxon, utc_now
from app.routers.selected_photo_export import ExportDownloadResponse
from tests.heic_fixtures import heic_bytes
from tests.test_photo_lifecycle import jpeg_bytes, upload
from tests.test_photo_lifecycle import lifecycle as lifecycle

URL = "/exports/selected"


@pytest.fixture(autouse=True)
def clean_exports():
    yield
    service.exports.close()


def prepare(client, ids, metadata=False):
    return client.post(URL, json={"photo_ids": ids, "include_metadata": metadata})


def test_success_metadata_and_one_use_cleanup(lifecycle):
    client, engine, settings = lifecycle
    payload = jpeg_bytes()
    photo = upload(client, payload, "žival 🦊.jpg").json()
    with Session(engine) as session:
        row = session.get(Photo, photo["id"])
        row.captured_at = datetime(2024, 7, 12, 10, 30)
        row.captured_at_offset_minutes = 120
        row.latitude, row.longitude = 46.1, 14.5
        row.tags, row.rating, row.is_favorite, row.culling_state = (
            ["wild"],
            5,
            True,
            "pick",
        )
        row.category, row.status = "mammal", "classified"
        taxon = Taxon(
            external_taxon_id="123",
            scientific_name="Vulpes vulpes",
            canonical_name="Vulpes vulpes",
            taxonomic_rank="SPECIES",
        )
        session.add(taxon)
        session.flush()
        animal = session.get(Animal, row.animal_id)
        animal.taxon_id, animal.taxonomy_status = taxon.id, "manually_linked"
        session.add(animal)
        session.add(row)
        session.commit()
    estimate = client.post(
        URL + "/estimate", json={"photo_ids": [photo["id"]], "include_metadata": True}
    )
    assert estimate.json()["original_bytes"] == len(payload)
    response = prepare(client, [photo["id"]], True)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    path = response.json()["download_path"]
    artifact = next(iter(service.exports.pending.values()))[0]
    download = client.get(path)
    assert (
        download.headers["content-disposition"]
        == 'attachment; filename="FaunaVault-Export.zip"'
    )
    assert len(download.content) == response.json()["download_bytes"]
    assert artifact.file.closed and not service.exports.pending
    assert client.get(path).status_code == 410
    with ZipFile(BytesIO(download.content)) as archive:
        metadata = json.loads(archive.read("metadata.json"))
        assert metadata["format"] == "faunavault-selected-photos"
        record = metadata["photos"][0]
        assert record["original_filename"] == "žival 🦊.jpg"
        assert record["captured_at"] == "2024-07-12T10:30:00"
        assert record["captured_at_offset_minutes"] == 120
        assert (record["latitude"], record["longitude"]) == (46.1, 14.5)
        assert (
            record["tags"],
            record["rating"],
            record["is_favorite"],
            record["culling_state"],
        ) == (["wild"], 5, True, "pick")
        assert record["verified_taxonomy"]["scientific_name"] == "Vulpes vulpes"
        assert record["original_sha256"] == hashlib.sha256(payload).hexdigest()
        assert archive.read(record["zip_member_path"]) == payload
        assert str(settings.image_dir) not in json.dumps(metadata)


def test_mixed_formats_duplicate_and_unicode_names(lifecycle):
    client, _, _ = lifecycle
    images = []
    for index, suffix in enumerate(["jpg", "jpeg", "png", "webp", "heic", "heif"]):
        output = BytesIO()
        if suffix in ("heic", "heif"):
            payload = heic_bytes(color=(index * 20, 60, 90))
        else:
            Image.new("RGB", (48, 32), (index * 20, 60, 90)).save(
                output,
                format={"jpg": "JPEG", "jpeg": "JPEG"}.get(suffix, suffix.upper()),
            )
            payload = output.getvalue()
        filename = "žival." + suffix
        response = client.post(
            "/photos/upload",
            files={
                "file": (
                    filename,
                    payload,
                    "image/jpeg" if suffix == "jpg" else f"image/{suffix}",
                )
            },
            data={"allow_visual_duplicate": "true"},
        )
        assert response.status_code == 200, response.text
        images.append((response.json()["id"], suffix, payload))
    duplicate = client.post(
        "/photos/upload",
        files={"file": ("žival.jpg", jpeg_bytes("blue"), "image/jpeg")},
        data={"allow_visual_duplicate": "true"},
    ).json()
    images.append((duplicate["id"], "jpg", jpeg_bytes("blue")))
    response = prepare(client, [row[0] for row in reversed(images)])
    assert response.status_code == 200, response.text
    with ZipFile(
        BytesIO(client.get(response.json()["download_path"]).content)
    ) as archive:
        assert "metadata.json" not in archive.namelist()
        assert len(archive.namelist()) == len(images)
        for photo_id, suffix, payload in images:
            assert archive.read(f"photos/{photo_id}-žival.{suffix}") == payload


@pytest.mark.parametrize(
    "ids", [[], [0], [-1], [1, 1], [True], [1.0], ["1"], [2**63], list(range(1, 252))]
)
def test_invalid_ids(lifecycle, ids):
    client, _, _ = lifecycle
    for endpoint in (URL, URL + "/estimate"):
        assert client.post(endpoint, json={"photo_ids": ids}).status_code == 422


def test_unsupported_configuration_and_missing_ids(lifecycle):
    client, _, _ = lifecycle
    assert prepare(client, [123456]).status_code == 409
    for extra in (
        {"mode": "resized"},
        {"include_metadata": "false"},
        {"path": "C:/secret"},
    ):
        assert client.post(URL, json={"photo_ids": [1], **extra}).status_code == 422


@pytest.mark.parametrize(
    "change", ["missing", "checksum", "size", "trash", "unsafe", "unsupported"]
)
def test_unavailable_originals_and_trash_cleanup(lifecycle, change, monkeypatch):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    path = settings.image_dirs["original"] / photo["stored_filename"]
    opened = []
    temporary_file = service.tempfile.TemporaryFile

    def track(**kwargs):
        result = temporary_file(**kwargs)
        opened.append(result)
        return result

    monkeypatch.setattr(service.tempfile, "TemporaryFile", track)
    with Session(engine) as session:
        row = session.get(Photo, photo["id"])
        if change == "missing":
            path.unlink()
        elif change == "checksum":
            payload = path.read_bytes()
            path.write_bytes(bytes([payload[0] ^ 1]) + payload[1:])
        elif change == "size":
            path.write_bytes(b"changed")
        elif change == "trash":
            row.deleted_at = utc_now()
        elif change == "unsafe":
            row.stored_filename = "../escape.jpg"
        elif change == "unsupported":
            row.stored_filename = "escape.tiff"
        session.add(row)
        session.commit()
    response = prepare(client, [photo["id"]])
    assert response.status_code in (409, 422), response.text
    assert not service.exports.pending
    assert all(file.closed for file in opened)


def test_symlink_rejected(lifecycle, tmp_path):
    client, _, settings = lifecycle
    photo = upload(client).json()
    path = settings.image_dirs["original"] / photo["stored_filename"]
    target = tmp_path / "outside.jpg"
    path.rename(target)
    try:
        path.symlink_to(target)
    except OSError:
        pytest.skip("OS requires symlink privilege")
    assert prepare(client, [photo["id"]]).status_code == 422


def test_size_limit_and_expired_unused_cleanup(lifecycle):
    client, _, settings = lifecycle
    photo = upload(client).json()
    settings.max_selected_export_bytes = 1
    assert prepare(client, [photo["id"]]).status_code == 413
    assert (
        client.post(URL + "/estimate", json={"photo_ids": [photo["id"]]}).status_code
        == 413
    )
    settings.max_selected_export_bytes = 1024**2
    response = prepare(client, [photo["id"]])
    token = response.json()["download_path"].rsplit("/", 1)[1]
    artifact = service.exports.pending[token][0]
    service.exports.expire(token)
    assert artifact.file.closed
    assert client.get(response.json()["download_path"]).status_code == 410


@pytest.mark.parametrize("change", ["metadata", "delete", "taxonomy", "original"])
def test_concurrent_changes_rejected(lifecycle, monkeypatch, change):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    real_hash = service.hash_file_stable

    def mutate(path):
        result = real_hash(path)
        with Session(engine) as session:
            row = session.get(Photo, photo["id"])
            if change == "metadata":
                row.is_favorite = True
            elif change == "delete":
                row.deleted_at = utc_now()
            elif change == "taxonomy":
                animal = session.get(Animal, row.animal_id)
                animal.taxonomy_note = "changed"
                session.add(animal)
            else:
                path.write_bytes(jpeg_bytes("blue"))
            session.add(row)
            session.commit()
        return result

    monkeypatch.setattr(service, "hash_file_stable", mutate)
    response = prepare(client, [photo["id"]], True)
    assert response.status_code == 409, response.text
    assert not service.exports.pending
    assert list(settings.staging_dir.iterdir()) == []


def test_safe_member_paths():
    for filename in (
        "C:\\private\\fox.jpg",
        "/private/fox.jpg",
        "../../fox.jpg",
        "..\\fox.jpg",
        "evil\x00:?.jpg",
    ):
        member = service.member_path(
            {"id": 123, "original_filename": filename, "stored_filename": "safe.jpg"}
        )
        assert member.startswith("photos/123-") and member.count("/") == 1
        assert "\\" not in member and ":" not in member and "\x00" not in member
    member = service.member_path(
        {
            "id": 123,
            "original_filename": "鳥" * 300 + ".HEIC",
            "stored_filename": "safe.heic",
        }
    )
    assert len(member.rsplit("/", 1)[1].encode("utf-8")) < 255
    assert member.endswith(".HEIC")


def test_link_guard_runs_without_os_symlink_privilege(lifecycle, monkeypatch):
    client, _, _ = lifecycle
    photo = upload(client).json()
    monkeypatch.setattr(service, "contains_link_or_junction", lambda path: True)
    assert prepare(client, [photo["id"]]).status_code == 422
    assert (
        client.post(URL + "/estimate", json={"photo_ids": [photo["id"]]}).status_code
        == 422
    )


@pytest.mark.parametrize("failure", ["disk", "corrupt_zip"])
def test_storage_or_archive_verification_failure_is_not_published(
    lifecycle, monkeypatch, failure
):
    client, _, _ = lifecycle
    photo = upload(client).json()
    opened = []
    real_temporary = service.tempfile.TemporaryFile

    def temporary(**kwargs):
        if failure == "disk":
            raise OSError("disk full at private path")
        file = real_temporary(**kwargs)
        opened.append(file)
        return file

    real_zip = service.ZipFile

    def corrupt(file, *args, **kwargs):
        if kwargs.get("mode", "r") == "r":
            file.seek(0)
            file.write(b"BROKEN")
            file.seek(0)
        return real_zip(file, *args, **kwargs)

    monkeypatch.setattr(service.tempfile, "TemporaryFile", temporary)
    if failure == "corrupt_zip":
        monkeypatch.setattr(service, "ZipFile", corrupt)
    response = prepare(client, [photo["id"]])
    assert response.status_code == (422 if failure == "disk" else 500), response.text
    assert "private path" not in response.text
    assert not service.exports.pending
    assert all(file.closed for file in opened)
    monkeypatch.setattr(service.tempfile, "TemporaryFile", real_temporary)
    monkeypatch.setattr(service, "ZipFile", real_zip)
    # A failed preparation must return its capacity slot.
    assert prepare(client, [photo["id"]]).status_code == 200


def test_exact_250_photo_and_size_boundaries(lifecycle):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    ids = [photo["id"]]
    with Session(engine) as session:
        original = session.get(Photo, photo["id"])
        values = original.model_dump(exclude={"id"})
        for _ in range(249):
            row = Photo(**values)
            session.add(row)
            session.flush()
            ids.append(row.id)
        session.commit()
    settings.max_selected_export_bytes = photo["original_size_bytes"] * 250
    response = prepare(client, ids)
    assert response.status_code == 200, response.text
    with ZipFile(
        BytesIO(client.get(response.json()["download_path"]).content)
    ) as archive:
        assert len(archive.namelist()) == 250
        assert len(set(archive.namelist())) == 250
    settings.max_selected_export_bytes -= 1
    assert prepare(client, ids).status_code == 413


def test_concurrent_capacity_released_on_success_and_shutdown(lifecycle):
    client, _, _ = lifecycle
    photo = upload(client).json()
    first, second = [prepare(client, [photo["id"]]) for _ in range(2)]
    assert first.status_code == second.status_code == 200
    assert prepare(client, [photo["id"]]).status_code == 429
    client.get(first.json()["download_path"])
    assert prepare(client, [photo["id"]]).status_code == 200
    artifacts = [entry[0] for entry in service.exports.pending.values()]
    service.exports.close()
    assert all(artifact.file.closed for artifact in artifacts)


def test_interrupted_download_closes_tempfile_and_releases_capacity(lifecycle):
    client, _, _ = lifecycle
    photo = upload(client).json()
    prepared = prepare(client, [photo["id"]]).json()
    token = prepared["download_path"].rsplit("/", 1)[1]
    artifact = service.exports.take(token)

    async def disconnect():
        async def receive():
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                raise OSError("client disconnected")

        try:
            await ExportDownloadResponse(artifact)(
                {"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send
            )
        except ClientDisconnect:
            pass

    asyncio.run(disconnect())
    assert artifact.file.closed
    assert prepare(client, [photo["id"]]).status_code == 200
