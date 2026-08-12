from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, SQLModel, create_engine, select

import app.main as main
from app.config import Settings
from app.migrations import run_migrations
from app.models import Animal, Photo
from app.services.photo_lifecycle import reconcile_purge_journal


def jpeg_bytes(color: str = "green", size: tuple[int, int] = (48, 32)) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format="JPEG")
    return output.getvalue()


def oriented_jpeg_bytes() -> bytes:
    output = BytesIO()
    exif = Image.Exif()
    exif[274] = 6
    Image.new("RGB", (40, 20), "purple").save(output, format="JPEG", exif=exif)
    return output.getvalue()


def assert_no_lifecycle_files(settings: Settings) -> None:
    assert not any(settings.staging_dir.iterdir())
    for directory in settings.image_dirs.values():
        assert not any(directory.iterdir())


def migration_database(tmp_path, applied_versions: tuple[int, ...]):
    database_path = tmp_path / "migration.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "migration-images",
        database_url=f"sqlite:///{database_path}",
    )
    engine = create_engine(settings.resolved_database_url)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE schema_migration "
            "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
        for version in applied_versions:
            connection.exec_driver_sql(
                "INSERT INTO schema_migration(version, applied_at) "
                "VALUES (?, CURRENT_TIMESTAMP)",
                (version,),
            )
    with Session(engine) as session:
        photo = Photo(
            original_filename="legacy.jpg",
            stored_filename="legacy.jpg",
            resized_filename="legacy_resized.jpg",
            thumbnail_filename="legacy_thumb.jpg",
            common_name=" Dog ",
            species_guess="golden retriever",
        )
        session.add(photo)
        session.commit()
        session.refresh(photo)
        photo_id = photo.id
    return engine, settings, photo_id


def migration_versions(engine) -> list[int]:
    with engine.connect() as connection:
        return [
            row[0]
            for row in connection.exec_driver_sql(
                "SELECT version FROM schema_migration ORDER BY version"
            )
        ]


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
    client, engine, settings = lifecycle
    response = upload(client)
    assert response.status_code == 200
    photo = response.json()
    assert len(photo["content_sha256"]) == 64
    assert photo["original_size_bytes"] > 0
    assert photo["media_type"] == "image/jpeg"
    assert photo["deleted_at"] is None
    with Session(engine) as session:
        animal = session.get(Animal, photo["animal_id"])
        assert animal is not None
        assert animal.legacy_species_group == "unidentified"
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
    assert versions == [1, 2, 3, 4, 5, 6, 7, 8, 9]
    with engine.connect() as connection:
        indexes = {
            row[1] for row in connection.exec_driver_sql("PRAGMA index_list(photo)")
        }
    assert {
        "ix_photo_catalog_active_created",
        "ix_photo_catalog_active_status_created",
        "ix_photo_catalog_active_category_created",
    } <= indexes
    with engine.connect() as connection:
        animal_indexes = {
            row[1] for row in connection.exec_driver_sql("PRAGMA index_list(animal)")
        }
    assert "ix_animal_legacy_species_group" in animal_indexes
    assert settings.database_path is not None
    backups = list(
        settings.database_path.parent.glob(
            f"{settings.database_path.stem}.pre-migrate-*{settings.database_path.suffix}"
        )
    )
    assert len(backups) == 1


def test_domestic_normalization_is_recorded_and_not_repeated(tmp_path, monkeypatch):
    engine, settings, photo_id = migration_database(tmp_path, (1, 2, 3, 4))
    monkeypatch.setattr(main, "engine", engine)
    calls = 0
    with Session(engine) as session:
        normalized = Photo(
            original_filename="normalized.jpg",
            stored_filename="normalized.jpg",
            resized_filename="normalized_resized.jpg",
            thumbnail_filename="normalized_thumb.jpg",
            display_title="beagle",
            common_name="dog",
            breed_guess="beagle",
            species_guess="Canis lupus familiaris",
            category="mammal",
        )
        session.add(normalized)
        session.commit()
        session.refresh(normalized)
        normalized_id = normalized.id
        normalized_updated_at = normalized.updated_at

    def normalize():
        nonlocal calls
        calls += 1
        main.normalize_existing_domestic_metadata()

    assert run_migrations(engine, settings, normalize) == [5, 6, 7, 8, 9]
    assert migration_versions(engine) == [1, 2, 3, 4, 5, 6, 7, 8, 9]
    with Session(engine) as session:
        photo = session.get(Photo, photo_id)
        assert photo is not None
        assert photo.common_name == "dog"
        assert photo.species_guess == "Canis lupus familiaris"
        assert photo.breed_guess == "golden retriever"
        assert photo.display_title == "golden retriever"
        assert photo.category == "mammal"
        unchanged = session.get(Photo, normalized_id)
        assert unchanged is not None
        assert unchanged.updated_at == normalized_updated_at

    assert run_migrations(engine, settings, normalize) == []
    assert calls == 1


def test_normalization_failure_stays_pending_and_retries_after_prior_migrations(
    tmp_path, monkeypatch
):
    engine, settings, photo_id = migration_database(tmp_path, (1,))
    monkeypatch.setattr(main, "engine", engine)

    def interrupted_normalization():
        raise RuntimeError("simulated process interruption")

    with pytest.raises(RuntimeError, match="simulated process interruption"):
        run_migrations(engine, settings, interrupted_normalization)

    assert migration_versions(engine) == [1, 2, 3, 4]
    with Session(engine) as session:
        photo = session.get(Photo, photo_id)
        assert photo is not None
        assert photo.species_guess == "golden retriever"

    assert run_migrations(
        engine, settings, main.normalize_existing_domestic_metadata
    ) == [5, 6, 7, 8, 9]
    assert migration_versions(engine) == [1, 2, 3, 4, 5, 6, 7, 8, 9]
    with Session(engine) as session:
        photo = session.get(Photo, photo_id)
        assert photo is not None
        assert photo.species_guess == "Canis lupus familiaris"


def test_migration_8_backfills_normalized_album_group_and_is_idempotent(tmp_path):
    database_path = tmp_path / "album-migration.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
    )
    engine = create_engine(settings.resolved_database_url)
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE photo (id INTEGER PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE animal (id INTEGER PRIMARY KEY, legacy_species_name TEXT)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE schema_migration "
            "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
        for version in range(1, 8):
            connection.exec_driver_sql(
                "INSERT INTO schema_migration VALUES (?, CURRENT_TIMESTAMP)",
                (version,),
            )
        connection.exec_driver_sql(
            "INSERT INTO animal(id, legacy_species_name) VALUES "
            "(1, '  ČRNA   Štorklja '), (2, NULL), (3, '   ')"
        )

    assert run_migrations(engine, settings) == [8, 9]
    with engine.connect() as connection:
        rows = connection.exec_driver_sql(
            "SELECT id, legacy_species_group FROM animal ORDER BY id"
        ).all()
        indexes = {
            row[1] for row in connection.exec_driver_sql("PRAGMA index_list(animal)")
        }
    assert rows == [(1, "črna štorklja"), (2, "unidentified"), (3, "")]
    assert "ix_animal_legacy_species_group" in indexes
    assert run_migrations(engine, settings) == []


def test_migration_9_adds_nullable_perceptual_hash_without_backfill(tmp_path):
    database_path = tmp_path / "perceptual-migration.db"
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{database_path}",
    )
    engine = create_engine(settings.resolved_database_url)
    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE photo (id INTEGER PRIMARY KEY)")
        connection.exec_driver_sql(
            "CREATE TABLE schema_migration "
            "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
        for version in range(1, 9):
            connection.exec_driver_sql(
                "INSERT INTO schema_migration VALUES (?, CURRENT_TIMESTAMP)",
                (version,),
            )
        connection.exec_driver_sql("INSERT INTO photo(id) VALUES (1)")

    assert run_migrations(engine, settings) == [9]
    with engine.connect() as connection:
        columns = {
            row[1] for row in connection.exec_driver_sql("PRAGMA table_info(photo)")
        }
        value = connection.exec_driver_sql(
            "SELECT perceptual_hash FROM photo WHERE id = 1"
        ).scalar_one()
    assert "perceptual_hash" in columns
    assert value is None
    assert run_migrations(engine, settings) == []


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


def test_upload_limits_return_stable_413_responses(lifecycle):
    client, _, settings = lifecycle
    payload = jpeg_bytes(size=(20, 20))
    settings.max_upload_bytes = len(payload) - 1
    oversized_file = upload(client, payload)
    assert oversized_file.status_code == 413
    assert oversized_file.json()["detail"] == "Uploaded image is too large"
    assert_no_lifecycle_files(settings)

    settings.max_upload_bytes = 1024 * 1024
    settings.max_image_pixels = 399
    oversized_image = upload(client, payload)
    assert oversized_image.status_code == 413
    assert oversized_image.json()["detail"] == "Image dimensions are too large"
    assert_no_lifecycle_files(settings)


def test_exif_orientation_preserves_original_and_orients_variants(lifecycle):
    client, _, settings = lifecycle
    payload = oriented_jpeg_bytes()
    response = upload(client, payload)
    assert response.status_code == 200
    photo = response.json()
    original = settings.image_dirs["original"] / photo["stored_filename"]
    assert original.read_bytes() == payload

    for image_type, field in (
        ("resized", "resized_filename"),
        ("thumbs", "thumbnail_filename"),
    ):
        with Image.open(settings.image_dirs[image_type] / photo[field]) as variant:
            assert variant.size == (20, 40)


def test_upload_flush_failure_rolls_back_and_removes_all_files(lifecycle, monkeypatch):
    client, engine, settings = lifecycle
    original_flush = Session.flush
    original_rollback = Session.rollback
    rollbacks = 0

    def fail_animal_flush(session, *args, **kwargs):
        if any(isinstance(item, Animal) for item in session.new):
            raise SQLAlchemyError("simulated flush failure")
        return original_flush(session, *args, **kwargs)

    def track_rollback(session, *args, **kwargs):
        nonlocal rollbacks
        rollbacks += 1
        return original_rollback(session, *args, **kwargs)

    monkeypatch.setattr(Session, "flush", fail_animal_flush)
    monkeypatch.setattr(Session, "rollback", track_rollback)
    response = upload(client)
    assert response.status_code == 500
    assert response.json()["detail"] == "Could not save the uploaded photo"
    assert rollbacks == 1
    assert_no_lifecycle_files(settings)
    with Session(engine) as session:
        assert session.exec(select(Photo)).all() == []
        assert session.exec(select(Animal)).all() == []


def test_batch_upload_commit_failure_cleans_up_and_next_item_succeeds(
    lifecycle, monkeypatch
):
    client, engine, settings = lifecycle
    original_commit = Session.commit
    original_rollback = Session.rollback
    should_fail = True
    rollbacks = 0

    def fail_first_commit(session, *args, **kwargs):
        nonlocal should_fail
        if should_fail:
            should_fail = False
            raise SQLAlchemyError("simulated commit failure")
        return original_commit(session, *args, **kwargs)

    def track_rollback(session, *args, **kwargs):
        nonlocal rollbacks
        rollbacks += 1
        return original_rollback(session, *args, **kwargs)

    monkeypatch.setattr(Session, "commit", fail_first_commit)
    monkeypatch.setattr(Session, "rollback", track_rollback)
    response = client.post(
        "/photos/upload-batch",
        files=[
            ("files", ("first.jpg", jpeg_bytes("orange"), "image/jpeg")),
            ("files", ("second.jpg", jpeg_bytes("blue"), "image/jpeg")),
        ],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["failed"] == [
        {
            "file_index": 0,
            "filename": "first.jpg",
            "error": "Could not save the uploaded photo",
            "code": None,
            "photo_id": None,
            "location": None,
        }
    ]
    assert len(body["uploaded"]) == 1
    assert body["uploaded"][0]["original_filename"] == "second.jpg"
    assert rollbacks >= 1
    assert not any(settings.staging_dir.iterdir())
    assert (
        sum(
            len(list(directory.iterdir())) for directory in settings.image_dirs.values()
        )
        == 3
    )
    with Session(engine) as session:
        assert len(session.exec(select(Photo)).all()) == 1
        assert len(session.exec(select(Animal)).all()) == 1


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


def test_permanent_delete_distinguishes_active_trashed_and_unknown(lifecycle):
    client, _, _ = lifecycle
    photo = upload(client).json()

    active = client.delete(f"/trash/photos/{photo['id']}")
    assert active.status_code == 409
    assert active.json()["detail"] == {
        "code": "photo_not_in_trash",
        "message": (
            "Photo must be moved to Trash before it can be permanently deleted."
        ),
    }

    unknown = client.delete("/trash/photos/999999")
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "Photo not found in Trash"

    assert client.delete(f"/photos/{photo['id']}").status_code == 200
    deleted = client.delete(f"/trash/photos/{photo['id']}")
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "deleted"


def test_permanent_delete_filesystem_failure_restores_files_and_record(
    lifecycle, monkeypatch
):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    assert client.delete(f"/photos/{photo['id']}").status_code == 200
    failed_source = settings.image_dirs["resized"] / photo["resized_filename"]
    original_replace = Path.replace

    def fail_resized_move(path, target):
        if path == failed_source:
            raise OSError("simulated staging failure")
        return original_replace(path, target)

    monkeypatch.setattr(Path, "replace", fail_resized_move)
    response = client.delete(f"/trash/photos/{photo['id']}")
    assert response.status_code == 500
    assert response.json()["detail"] == "Could not stage photo files for deletion"
    assert not any(settings.purge_dir.iterdir())
    for image_type, field in (
        ("original", "stored_filename"),
        ("resized", "resized_filename"),
        ("thumbs", "thumbnail_filename"),
    ):
        assert (settings.image_dirs[image_type] / photo[field]).is_file()
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        assert stored is not None
        assert stored.deleted_at is not None


def test_permanent_delete_commit_failure_rolls_back_and_restores_files(
    lifecycle, monkeypatch
):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    assert client.delete(f"/photos/{photo['id']}").status_code == 200
    original_commit = Session.commit
    original_rollback = Session.rollback
    rollbacks = 0

    def fail_commit(session, *args, **kwargs):
        raise SQLAlchemyError("simulated commit failure")

    def track_rollback(session, *args, **kwargs):
        nonlocal rollbacks
        rollbacks += 1
        return original_rollback(session, *args, **kwargs)

    monkeypatch.setattr(Session, "commit", fail_commit)
    monkeypatch.setattr(Session, "rollback", track_rollback)
    response = client.delete(f"/trash/photos/{photo['id']}")
    assert response.status_code == 500
    assert response.json()["detail"] == "Could not permanently delete photo"
    assert rollbacks == 1
    assert not any(settings.purge_dir.iterdir())
    for image_type, field in (
        ("original", "stored_filename"),
        ("resized", "resized_filename"),
        ("thumbs", "thumbnail_filename"),
    ):
        assert (settings.image_dirs[image_type] / photo[field]).is_file()

    monkeypatch.setattr(Session, "commit", original_commit)
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        assert stored is not None
        assert stored.deleted_at is not None


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
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        assert stored is not None
        assert stored.deleted_at is not None


def test_interrupted_purge_finishes_cleanup_when_record_is_gone(lifecycle):
    client, engine, settings = lifecycle
    photo = upload(client).json()
    client.delete(f"/photos/{photo['id']}")
    operation = settings.purge_dir / "committed-interruption"
    files = []
    for image_type, field in (
        ("original", "stored_filename"),
        ("resized", "resized_filename"),
        ("thumbs", "thumbnail_filename"),
    ):
        filename = photo[field]
        staged_dir = operation / image_type
        staged_dir.mkdir(parents=True, exist_ok=True)
        (settings.image_dirs[image_type] / filename).replace(staged_dir / filename)
        files.append({"type": image_type, "filename": filename})
    (operation / "manifest.json").write_text(
        json.dumps({"photo_id": photo["id"], "phase": "staged", "files": files}),
        encoding="utf-8",
    )
    with Session(engine) as session:
        stored = session.get(Photo, photo["id"])
        assert stored is not None
        session.delete(stored)
        session.commit()
        reconcile_purge_journal(session, settings)

    assert not operation.exists()
    with Session(engine) as session:
        assert session.get(Photo, photo["id"]) is None
    for image_type, field in (
        ("original", "stored_filename"),
        ("resized", "resized_filename"),
        ("thumbs", "thumbnail_filename"),
    ):
        assert not (settings.image_dirs[image_type] / photo[field]).exists()
