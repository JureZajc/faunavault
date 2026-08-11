from __future__ import annotations

import json
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlmodel import Session, SQLModel, create_engine

import app.main as main
from app.config import Settings
from app.services.photo_lifecycle import reconcile_purge_journal


def jpeg_bytes(color: str = "green", size: tuple[int, int] = (48, 32)) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format="JPEG")
    return output.getvalue()


@pytest.fixture()
def lifecycle(tmp_path, monkeypatch):
    database_path = tmp_path / "faunavault.db"
    image_dir = tmp_path / "images"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=image_dir,
        database_url=f"sqlite:///{database_path}",
        max_upload_bytes=1024 * 1024,
        max_image_pixels=1_000_000,
    )
    engine = create_engine(
        settings.resolved_database_url,
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(main, "settings", settings)
    monkeypatch.setattr(main, "IMAGE_ROOT", image_dir)
    monkeypatch.setattr(main, "IMAGE_DIRS", settings.image_dirs)
    monkeypatch.setattr(main, "DATABASE_PATH", database_path)

    def session_override():
        with Session(engine) as session:
            yield session

    main.app.dependency_overrides[main.get_session] = session_override
    with TestClient(main.app) as client:
        yield client, engine, settings
    main.app.dependency_overrides.clear()


def upload(client: TestClient, payload: bytes | None = None, filename: str = "fox.jpg"):
    return client.post(
        "/photos/upload",
        files={"file": (filename, payload or jpeg_bytes(), "image/jpeg")},
    )


def test_upload_generates_variants_and_rejects_safe_duplicate(lifecycle):
    client, _, settings = lifecycle
    response = upload(client)
    assert response.status_code == 200
    photo = response.json()
    assert len(photo["content_sha256"]) == 64
    assert photo["original_size_bytes"] > 0
    assert photo["media_type"] == "image/jpeg"
    assert photo["deleted_at"] is None
    assert (settings.image_dirs["original"] / photo["stored_filename"]).is_file()
    assert (settings.image_dirs["resized"] / photo["resized_filename"]).is_file()
    assert (settings.image_dirs["thumbs"] / photo["thumbnail_filename"]).is_file()

    duplicate = upload(client, filename="different-name.jpg")
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == {
        "code": "duplicate_photo",
        "message": "This image is already in FaunaVault.",
        "photo_id": photo["id"],
        "location": "catalog",
    }


def test_startup_migrations_are_versioned_and_back_up_the_actual_database(lifecycle):
    _, engine, settings = lifecycle
    with engine.connect() as connection:
        versions = [
            row[0]
            for row in connection.exec_driver_sql(
                "SELECT version FROM schema_migration ORDER BY version"
            )
        ]
    assert versions == [1, 2, 3, 4]
    assert settings.database_path is not None
    backups = list(
        settings.database_path.parent.glob(
            f"{settings.database_path.stem}.pre-migrate-*{settings.database_path.suffix}"
        )
    )
    assert len(backups) == 1


def test_upload_validates_mime_corruption_size_and_batch_recovery(lifecycle):
    client, _, _ = lifecycle
    mismatch = client.post(
        "/photos/upload",
        files={"file": ("fox.png", jpeg_bytes(), "image/png")},
    )
    assert mismatch.status_code == 415
    corrupt = client.post(
        "/photos/upload",
        files={"file": ("bad.jpg", b"not an image", "image/jpeg")},
    )
    assert corrupt.status_code == 400

    batch = client.post(
        "/photos/upload-batch",
        files=[
            ("files", ("bad.jpg", b"bad", "image/jpeg")),
            ("files", ("valid.jpg", jpeg_bytes("blue"), "image/jpeg")),
        ],
    )
    assert batch.status_code == 200
    assert len(batch.json()["failed"]) == 1
    assert len(batch.json()["uploaded"]) == 1


def test_soft_delete_is_hidden_restorable_and_duplicate_aware(lifecycle):
    client, _, _ = lifecycle
    photo = upload(client).json()
    deleted = client.delete(f"/photos/{photo['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "trashed"
    assert client.get("/photos").json() == []
    assert client.get(f"/photos/{photo['id']}").status_code == 404

    trash = client.get("/trash/photos").json()
    assert trash["total"] == 1
    assert trash["items"][0]["id"] == photo["id"]
    duplicate = upload(client)
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["location"] == "trash"

    restored = client.post(f"/trash/photos/{photo['id']}/restore")
    assert restored.status_code == 200
    assert client.get(f"/photos/{photo['id']}").status_code == 200


def test_permanent_delete_removes_variants_and_preserves_animal(lifecycle):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    client.delete(f"/photos/{photo['id']}")
    response = client.delete(f"/trash/photos/{photo['id']}")
    assert response.status_code == 200
    assert response.json()["missing_files"] == 0
    assert client.get("/trash/photos").json()["total"] == 0
    for image_type, field in (
        ("original", "stored_filename"),
        ("resized", "resized_filename"),
        ("thumbs", "thumbnail_filename"),
    ):
        assert not (settings.image_dirs[image_type] / photo[field]).exists()
    with Session(engine) as session:
        assert session.get(main.Animal, photo["animal_id"]) is not None


def test_permanent_delete_reports_missing_variant(lifecycle):
    client, _, settings = lifecycle
    photo = upload(client).json()
    client.delete(f"/photos/{photo['id']}")
    (settings.image_dirs["thumbs"] / photo["thumbnail_filename"]).unlink()
    response = client.delete(f"/trash/photos/{photo['id']}")
    assert response.status_code == 200
    assert response.json()["missing_files"] == 1


def test_interrupted_purge_restores_files_when_record_still_exists(lifecycle):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    client.delete(f"/photos/{photo['id']}")
    operation = settings.purge_dir / "interrupted"
    staged_dir = operation / "original"
    staged_dir.mkdir(parents=True)
    original = settings.image_dirs["original"] / photo["stored_filename"]
    original.replace(staged_dir / photo["stored_filename"])
    (operation / "manifest.json").write_text(
        json.dumps(
            {
                "photo_id": photo["id"],
                "phase": "staging",
                "files": [{"type": "original", "filename": photo["stored_filename"]}],
            }
        ),
        encoding="utf-8",
    )
    with Session(engine) as session:
        reconcile_purge_journal(session, settings)
    assert original.is_file()
    assert not operation.exists()
