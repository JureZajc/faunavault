from __future__ import annotations

import csv
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError
from sqlmodel import Session, SQLModel

import app.archive_export.service as export_service
import app.cli.export as export_cli
from app.archive_export.schema import ArchiveMetadataExport
from app.archive_export.service import (
    CSV_COLUMNS,
    ArchiveExportIntegrityError,
    ArchiveExportSetupError,
    create_metadata_export,
)
from app.config import Settings
from app.database import create_database_engine
from app.models import Animal, ClassificationJob, Photo, Taxon

STAMP = datetime(2026, 8, 20, 8, 0, tzinfo=UTC)


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


@dataclass(frozen=True)
class ArchiveFixture:
    settings: Settings
    stored_names: tuple[str, ...]
    source_root: Path


def _create_archive(tmp_path: Path, *, populated: bool = True) -> ArchiveFixture:
    source = tmp_path / "source archive"
    database_path = source / "data" / "faunavault.db"
    image_root = source / "images"
    database_path.parent.mkdir(parents=True)
    settings = Settings(
        _env_file=None,
        data_dir=source / "data",
        image_dir=image_root,
        database_url=f"sqlite:///{database_path.as_posix()}",
        ollama_base_url="https://SECRET-OLLAMA.invalid/sentinel",
        gbif_base_url="https://SECRET-GBIF.invalid/sentinel",
        ai_primary_model="SECRET-MODEL",
    )
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True)

    engine = create_database_engine(settings)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE schema_migration "
            "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
        )
        for version in range(1, 10):
            connection.exec_driver_sql(
                "INSERT INTO schema_migration VALUES (?, CURRENT_TIMESTAMP)",
                (version,),
            )

    stored_names: tuple[str, ...] = ()
    if populated:
        stored_names = ("one.jpg", "two.png", "three.webp")
        payloads = (b"authoritative-one", b"authoritative-two", b"third")
        for name, payload in zip(stored_names, payloads, strict=True):
            (settings.image_dirs["original"] / name).write_bytes(payload)

        with Session(engine) as session:
            linked_taxon = Taxon(
                provider="gbif",
                external_taxon_id="00123",
                scientific_name="Črna štorklja",
                canonical_name="Ciconia nigra",
                common_name="黑鹳",
                taxonomic_rank="SPECIES",
                kingdom="Animalia",
                phylum="Chordata",
                taxonomic_class="Aves",
                taxonomic_order="Ciconiiformes",
                family="Ciconiidae",
                genus="Ciconia",
                species="Ciconia nigra",
                synchronized_at=STAMP,
            )
            unreferenced_taxon = Taxon(
                provider="local",
                external_taxon_id="taxon-unreferenced",
                scientific_name="テスト分類群",
                canonical_name="テスト分類群",
                taxonomic_rank="SPECIES",
                synchronized_at=STAMP,
            )
            session.add(linked_taxon)
            session.add(unreferenced_taxon)
            session.flush()
            linked_animal = Animal(
                identifier="FV-ČRNA-1",
                display_name="Živa",
                taxon_id=linked_taxon.id,
                legacy_common_name="štorklja",
                legacy_species_name=" Črna\t štorklja ",
                taxonomy_status="manually_linked",
                taxonomy_note="Potrjeno, ročno",
                created_at=STAMP,
                updated_at=STAMP,
            )
            trash_animal = Animal(
                identifier="FV-TRASH-2",
                display_name=None,
                legacy_common_name="",
                legacy_species_name="Nočna žaba",
                taxonomy_status="unreviewed",
                created_at=STAMP,
                updated_at=STAMP,
            )
            independent_animal = Animal(
                identifier="FV-INDEPENDENT-3",
                display_name="独立個体",
                taxonomy_status="unreviewed",
                created_at=STAMP,
                updated_at=STAMP,
            )
            session.add(linked_animal)
            session.add(trash_animal)
            session.add(independent_animal)
            session.flush()
            photos = [
                Photo(
                    original_filename='črna, "štorklja".jpg',
                    stored_filename=stored_names[0],
                    resized_filename="SECRET-DERIVATIVE-resized.jpg",
                    thumbnail_filename="SECRET-DERIVATIVE-thumb.jpg",
                    display_title="Črna štorklja",
                    common_name="štorklja",
                    breed_guess=None,
                    species_guess="Ciconia nigra",
                    category="bird; wild",
                    confidence=0.875,
                    description='Vrstica ena, "citirano".\nVrstica dve\tza konec.',
                    tags=["črna,ptica", r"\N", "ohrani;vrstni red"],
                    status="classified",
                    animal_id=linked_animal.id,
                    content_sha256=_digest(payloads[0]),
                    perceptual_hash="0123456789abcdef",
                    original_size_bytes=len(payloads[0]),
                    media_type="image/jpeg",
                    created_at=STAMP,
                    updated_at=STAMP,
                ),
                Photo(
                    original_filename="žaba.png",
                    stored_filename=stored_names[1],
                    resized_filename="two_resized.png",
                    thumbnail_filename="two_thumb.png",
                    display_title=None,
                    description=None,
                    tags=[],
                    status="needs_review",
                    animal_id=trash_animal.id,
                    content_sha256=None,
                    original_size_bytes=None,
                    media_type="image/png",
                    deleted_at=STAMP,
                    created_at=STAMP,
                    updated_at=STAMP,
                ),
                Photo(
                    original_filename="empty-description.webp",
                    stored_filename=stored_names[2],
                    resized_filename="three_resized.webp",
                    thumbnail_filename="three_thumb.webp",
                    display_title=r"\N",
                    description="",
                    tags=["日本語"],
                    status="pending",
                    animal_id=None,
                    content_sha256=_digest(payloads[2]),
                    original_size_bytes=len(payloads[2]),
                    media_type="image/webp",
                    created_at=STAMP,
                    updated_at=STAMP,
                ),
            ]
            session.add_all(photos)
            session.flush()
            session.add(
                ClassificationJob(
                    photo_id=photos[0].id,
                    status="failed",
                    batch_id="SECRET-BATCH",
                    batch_kind="single",
                    requested_model="SECRET-REQUESTED-MODEL",
                    prompt_version="secret-prompt",
                    failure_message="SECRET-FAILURE-MESSAGE",
                    source_photo_updated_at=STAMP,
                    created_at=STAMP,
                    queued_at=STAMP,
                )
            )
            session.commit()
    engine.dispose()
    return ArchiveFixture(settings, stored_names, source)


@pytest.fixture()
def archive(tmp_path) -> ArchiveFixture:
    return _create_archive(tmp_path)


def _decode_csv(value: str) -> str | None:
    if value == r"\N":
        return None
    if value.startswith(r"\\"):
        return value[1:]
    return value


def test_export_is_deterministic_complete_portable_and_round_trips(
    archive: ArchiveFixture, tmp_path: Path
):
    first = create_metadata_export(
        tmp_path / "export one", archive.settings, include_csv=True
    )
    second = create_metadata_export(
        tmp_path / "export two", archive.settings, include_csv=True
    )

    first_json = first.json_path.read_bytes()
    second_json = second.json_path.read_bytes()
    first_csv = first.csv_path.read_bytes() if first.csv_path else b""
    second_csv = second.csv_path.read_bytes() if second.csv_path else b""
    assert first_json == second_json
    assert first_csv == second_csv
    assert first_json.endswith(b"\n") and not first_json.startswith(b"\xef\xbb\xbf")
    assert first_csv.endswith(b"\n") and b"\r\n" not in first_csv

    payload = json.loads(first_json)
    validated = ArchiveMetadataExport.model_validate(payload)
    assert payload["format_version"] == 1
    assert payload["source_database_schema_version"] == 9
    assert payload["counts"] == {
        "photos": 3,
        "active_photos": 2,
        "trashed_photos": 1,
        "animals": 3,
        "taxa": 2,
        "original_bytes": len(b"authoritative-oneauthoritative-twothird"),
    }
    assert [photo["id"] for photo in payload["photos"]] == [1, 2, 3]
    assert [photo["lifecycle_state"] for photo in payload["photos"]] == [
        "active",
        "trash",
        "active",
    ]
    assert payload["photos"][0]["description"].endswith("Vrstica dve\tza konec.")
    assert payload["photos"][0]["tags"] == [
        "črna,ptica",
        r"\N",
        "ohrani;vrstni red",
    ]
    assert payload["photos"][1]["display_title"] is None
    assert payload["photos"][2]["description"] == ""
    assert payload["photos"][0]["created_at"] == "2026-08-20T08:00:00.000000Z"
    assert payload["animals"][1]["legacy_common_name"] == ""
    assert "legacy_species_group" not in payload["animals"][0]
    assert payload["taxa"][0]["external_taxon_id"] == "00123"
    assert payload["taxa"][0]["class"] == "Aves"
    assert payload["taxa"][1]["scientific_name"] == "テスト分類群"
    assert validated.counts.original_bytes == payload["counts"]["original_bytes"]
    assert first.missing_stored_identity_photos == 1

    artifact_bytes = first_json + first_csv
    for forbidden in (
        str(archive.settings.database_path),
        str(archive.settings.image_dir),
        "SECRET-OLLAMA",
        "SECRET-GBIF",
        "SECRET-MODEL",
        "SECRET-DERIVATIVE",
        "0123456789abcdef",
        "SECRET-BATCH",
        "SECRET-FAILURE-MESSAGE",
        "faunavault-export-snapshot-",
    ):
        assert forbidden.encode() not in artifact_bytes
    assert sorted(path.name for path in first.destination.iterdir()) == [
        "archive-metadata.json",
        "photos.csv",
    ]

    assert first.csv_path is not None
    with first.csv_path.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    assert tuple(rows[0]) == CSV_COLUMNS
    assert [int(row["photo_id"]) for row in rows] == [1, 2, 3]
    assert rows[0]["description"] == payload["photos"][0]["description"]
    assert json.loads(rows[0]["tags"]) == payload["photos"][0]["tags"]
    assert _decode_csv(rows[1]["display_title"]) is None
    assert _decode_csv(rows[2]["description"]) == ""
    assert _decode_csv(rows[2]["display_title"]) == r"\N"
    assert rows[0]["taxon_external_id"] == "00123"
    assert _decode_csv(rows[1]["taxon_id"]) is None
    assert _decode_csv(rows[2]["animal_id"]) is None


def test_empty_archive_exports_valid_json_and_header_only_csv(tmp_path: Path):
    archive = _create_archive(tmp_path, populated=False)
    result = create_metadata_export(
        tmp_path / "empty export", archive.settings, include_csv=True
    )

    payload = json.loads(result.json_path.read_text(encoding="utf-8"))
    assert payload["counts"] == {
        "photos": 0,
        "active_photos": 0,
        "trashed_photos": 0,
        "animals": 0,
        "taxa": 0,
        "original_bytes": 0,
    }
    assert payload["photos"] == payload["animals"] == payload["taxa"] == []
    assert result.csv_path is not None
    with result.csv_path.open(encoding="utf-8", newline="") as source:
        assert list(csv.reader(source)) == [list(CSV_COLUMNS)]


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ("missing", "missing or not a regular file"),
        ("sha", "SHA-256 disagrees"),
        ("size", "size disagrees"),
        ("unsafe", "Unsafe stored image path"),
        ("collision", "case-colliding"),
        ("tags", "Invalid tags"),
        ("timestamp", "Invalid timestamp"),
        ("confidence", "less than or equal to 1"),
    ],
)
def test_invalid_source_fails_before_publication(
    archive: ArchiveFixture, tmp_path: Path, mutation: str, message: str
):
    database = archive.settings.database_path
    assert database is not None
    if mutation == "missing":
        (archive.settings.image_dirs["original"] / archive.stored_names[0]).unlink()
    else:
        connection = sqlite3.connect(database)
        try:
            if mutation == "sha":
                connection.execute(
                    "UPDATE photo SET content_sha256 = ? WHERE id = 1", ("0" * 64,)
                )
            elif mutation == "size":
                connection.execute(
                    "UPDATE photo SET original_size_bytes = 999 WHERE id = 1"
                )
            elif mutation == "unsafe":
                connection.execute(
                    "UPDATE photo SET stored_filename = '../escape.jpg' WHERE id = 1"
                )
            elif mutation == "collision":
                connection.execute(
                    "UPDATE photo SET stored_filename = 'ONE.JPG' WHERE id = 2"
                )
            elif mutation == "tags":
                connection.execute("UPDATE photo SET tags = 'not-json' WHERE id = 1")
            elif mutation == "timestamp":
                connection.execute(
                    "UPDATE photo SET created_at = 'not-a-time' WHERE id = 1"
                )
            elif mutation == "confidence":
                connection.execute("UPDATE photo SET confidence = 2 WHERE id = 1")
            connection.commit()
        finally:
            connection.close()

    destination = tmp_path / f"failed-{mutation}"
    with pytest.raises(ArchiveExportIntegrityError, match=message):
        create_metadata_export(destination, archive.settings)
    assert not destination.exists()
    assert not list(
        tmp_path.glob(f".{destination.name}.faunavault-export-incomplete-*")
    )


def test_foreign_key_and_schema_state_are_required(
    archive: ArchiveFixture, tmp_path: Path
):
    database = archive.settings.database_path
    assert database is not None
    connection = sqlite3.connect(database)
    connection.execute("PRAGMA foreign_keys=OFF")
    connection.execute("UPDATE photo SET animal_id = 999999 WHERE id = 1")
    connection.commit()
    connection.close()

    with pytest.raises(ArchiveExportIntegrityError, match="foreign_key_check"):
        create_metadata_export(tmp_path / "bad-foreign-key", archive.settings)

    connection = sqlite3.connect(database)
    connection.execute("UPDATE photo SET animal_id = 1 WHERE id = 1")
    connection.execute("DELETE FROM schema_migration WHERE version = 9")
    connection.commit()
    connection.close()
    with pytest.raises(ArchiveExportIntegrityError, match="migration state"):
        create_metadata_export(tmp_path / "bad-schema", archive.settings)


def test_original_change_or_disappearance_after_snapshot_fails(
    archive: ArchiveFixture, tmp_path: Path
):
    original = archive.settings.image_dirs["original"] / archive.stored_names[0]

    def remove_after_snapshot() -> None:
        original.unlink()

    with pytest.raises(ArchiveExportIntegrityError, match="missing"):
        create_metadata_export(
            tmp_path / "removed", archive.settings, after_snapshot=remove_after_snapshot
        )

    original.write_bytes(b"authoritative-one")

    def change_before_publish() -> None:
        original.write_bytes(b"authoritative-one")
        original.touch()

    with pytest.raises(ArchiveExportIntegrityError, match="changed before publication"):
        create_metadata_export(
            tmp_path / "changed",
            archive.settings,
            before_publish=change_before_publish,
        )


def test_unrelated_live_commit_after_snapshot_is_intentionally_excluded(
    archive: ArchiveFixture, tmp_path: Path
):
    database = archive.settings.database_path
    assert database is not None

    def add_live_animal() -> None:
        connection = sqlite3.connect(database)
        connection.execute(
            "INSERT INTO animal (identifier, legacy_species_group, taxonomy_status, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (
                "FV-AFTER-SNAPSHOT",
                "unidentified",
                "unreviewed",
                "2026-08-20 09:00:00.000000",
                "2026-08-20 09:00:00.000000",
            ),
        )
        connection.commit()
        connection.close()

    result = create_metadata_export(
        tmp_path / "point in time", archive.settings, before_publish=add_live_animal
    )
    assert result.document.counts.animals == 3
    assert all(
        animal.identifier != "FV-AFTER-SNAPSHOT" for animal in result.document.animals
    )


def test_destination_safety_and_output_failure_cleanup(
    archive: ArchiveFixture, tmp_path: Path, monkeypatch
):
    existing = tmp_path / "existing"
    existing.mkdir()
    with pytest.raises(ArchiveExportSetupError, match="must not already exist"):
        create_metadata_export(existing, archive.settings)
    with pytest.raises(ArchiveExportSetupError, match="overlaps"):
        create_metadata_export(
            archive.settings.image_dirs["original"] / "nested", archive.settings
        )
    with pytest.raises(ArchiveExportSetupError, match="Remote and URL"):
        create_metadata_export(Path("https://example.test/export"), archive.settings)

    destination = tmp_path / "write-failure"

    def fail_write(_path, _document) -> None:
        raise OSError("injected output failure")

    monkeypatch.setattr(export_service, "_write_and_validate_json", fail_write)
    with pytest.raises(ArchiveExportSetupError, match="injected output failure"):
        create_metadata_export(destination, archive.settings)
    assert not destination.exists()
    assert not list(
        tmp_path.glob(f".{destination.name}.faunavault-export-incomplete-*")
    )


def test_source_symlink_is_rejected_when_supported(
    archive: ArchiveFixture, tmp_path: Path
):
    source = archive.settings.image_dirs["original"] / archive.stored_names[0]
    outside = tmp_path / "outside.jpg"
    outside.write_bytes(source.read_bytes())
    source.unlink()
    try:
        source.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation is unavailable")

    with pytest.raises(ArchiveExportIntegrityError, match="regular file"):
        create_metadata_export(tmp_path / "linked-source", archive.settings)


def test_cli_summary_warnings_exit_codes_and_help(
    archive: ArchiveFixture, tmp_path: Path, monkeypatch, capsys
):
    monkeypatch.setattr(export_cli, "get_settings", lambda: archive.settings)
    destination = tmp_path / "cli export"

    assert export_cli.main([str(destination), "--csv"]) == 0
    captured = capsys.readouterr()
    assert "Metadata export: COMPLETE" in captured.out
    assert "Format: v1" in captured.out
    assert "Photos: 3 total / 2 active / 1 Trash" in captured.out
    assert "1 photo(s) lacked a stored original size or SHA-256" in captured.out
    assert "Inventorying originals: 3 / 3" in captured.err
    assert str(archive.settings.image_dir) not in captured.out

    assert export_cli.main([str(destination)]) == 2
    assert "could not start" in capsys.readouterr().err

    (archive.settings.image_dirs["original"] / archive.stored_names[0]).unlink()
    assert export_cli.main([str(tmp_path / "cli failure")]) == 1
    failure = capsys.readouterr().err
    assert "Metadata export: FAILED" in failure
    assert "faunavault-maintenance doctor" in failure

    with pytest.raises(SystemExit) as help_exit:
        export_cli.main(["--help"])
    assert help_exit.value.code == 0
    assert "not a backup or restore format" in capsys.readouterr().out


def test_format_version_is_independent_and_schema_rejects_bad_artifacts(
    archive: ArchiveFixture, tmp_path: Path
):
    result = create_metadata_export(tmp_path / "valid", archive.settings)
    payload = json.loads(result.json_path.read_text(encoding="utf-8"))
    payload["source_database_schema_version"] = 10
    assert ArchiveMetadataExport.model_validate(payload).format_version == 1

    payload["format_version"] = 2
    with pytest.raises(ValidationError):
        ArchiveMetadataExport.model_validate(payload)

    payload["format_version"] = 1
    payload["photos"][0]["original_sha256"] = "BAD"
    with pytest.raises(ValidationError):
        ArchiveMetadataExport.model_validate(payload)
