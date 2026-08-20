from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

EXPORT_FORMAT_VERSION = 1
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")


def validate_export_timestamp(value: str) -> str:
    if not TIMESTAMP_PATTERN.fullmatch(value):
        raise ValueError("timestamp must use canonical UTC ISO-8601 representation")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("timestamp must be a valid date and time") from exc
    return value


def validate_original_path(value: str) -> str:
    if not value or "\\" in value:
        raise ValueError("original path must be a non-empty POSIX path")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or path.parts[:2] != ("images", "original")
        or len(path.parts) != 3
        or any(part in {"", ".", ".."} for part in path.parts)
        or path.as_posix() != value
    ):
        raise ValueError("original path must match images/original/<stored filename>")
    return value


class StrictExportModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)


class ExportCounts(StrictExportModel):
    photos: int = Field(ge=0)
    active_photos: int = Field(ge=0)
    trashed_photos: int = Field(ge=0)
    animals: int = Field(ge=0)
    taxa: int = Field(ge=0)
    original_bytes: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_photo_counts(self) -> ExportCounts:
        if self.photos != self.active_photos + self.trashed_photos:
            raise ValueError("active and Trash photo counts do not match total")
        return self


class PhotoExport(StrictExportModel):
    id: int = Field(ge=1)
    original_filename: str
    archive_relative_original_path: str
    media_type: str | None
    original_size_bytes: int = Field(ge=0)
    original_sha256: str
    display_title: str | None
    common_name: str | None
    breed_guess: str | None
    species_guess: str | None
    category: str | None
    confidence: float | None = Field(default=None, ge=0, le=1)
    description: str | None
    tags: list[str]
    status: str = Field(min_length=1)
    animal_id: int | None = Field(default=None, ge=1)
    lifecycle_state: Literal["active", "trash"]
    deleted_at: str | None
    created_at: str
    updated_at: str

    _validate_path = field_validator("archive_relative_original_path")(
        validate_original_path
    )

    @field_validator("original_sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not SHA256_PATTERN.fullmatch(value):
            raise ValueError("SHA-256 must contain 64 lowercase hexadecimal characters")
        return value

    @field_validator("deleted_at")
    @classmethod
    def validate_optional_timestamp(cls, value: str | None) -> str | None:
        return validate_export_timestamp(value) if value is not None else None

    @field_validator("created_at", "updated_at")
    @classmethod
    def validate_timestamp(cls, value: str) -> str:
        return validate_export_timestamp(value)

    @model_validator(mode="after")
    def validate_lifecycle(self) -> PhotoExport:
        if self.lifecycle_state == "active" and self.deleted_at is not None:
            raise ValueError("active photos must not have a deleted timestamp")
        if self.lifecycle_state == "trash" and self.deleted_at is None:
            raise ValueError("Trash photos must have a deleted timestamp")
        return self


class AnimalExport(StrictExportModel):
    id: int = Field(ge=1)
    identifier: str = Field(min_length=1)
    display_name: str | None
    taxon_id: int | None = Field(default=None, ge=1)
    legacy_common_name: str | None
    legacy_species_name: str | None
    taxonomy_status: str = Field(min_length=1)
    taxonomy_note: str | None
    created_at: str
    updated_at: str

    @field_validator("created_at", "updated_at")
    @classmethod
    def validate_timestamp(cls, value: str) -> str:
        return validate_export_timestamp(value)


class TaxonExport(StrictExportModel):
    id: int = Field(ge=1)
    provider: str = Field(min_length=1)
    external_taxon_id: str = Field(min_length=1)
    scientific_name: str = Field(min_length=1)
    canonical_name: str = Field(min_length=1)
    common_name: str | None
    rank: str = Field(min_length=1)
    kingdom: str | None
    phylum: str | None
    taxonomic_class: str | None = Field(alias="class", serialization_alias="class")
    taxonomic_order: str | None = Field(alias="order", serialization_alias="order")
    family: str | None
    genus: str | None
    species: str | None
    synchronized_at: str

    @field_validator("synchronized_at")
    @classmethod
    def validate_timestamp(cls, value: str) -> str:
        return validate_export_timestamp(value)


class ArchiveMetadataExport(StrictExportModel):
    format_version: Literal[EXPORT_FORMAT_VERSION]
    source_database_schema_version: int = Field(ge=1)
    counts: ExportCounts
    photos: list[PhotoExport]
    animals: list[AnimalExport]
    taxa: list[TaxonExport]

    @staticmethod
    def _validate_order(records: list[object], label: str) -> None:
        identifiers = [record.id for record in records]
        if identifiers != sorted(identifiers) or len(identifiers) != len(
            set(identifiers)
        ):
            raise ValueError(f"{label} IDs must be unique and strictly ascending")

    @model_validator(mode="after")
    def validate_archive(self) -> ArchiveMetadataExport:
        self._validate_order(self.photos, "photo")
        self._validate_order(self.animals, "animal")
        self._validate_order(self.taxa, "taxon")

        active = sum(photo.lifecycle_state == "active" for photo in self.photos)
        trashed = sum(photo.lifecycle_state == "trash" for photo in self.photos)
        actual_counts = {
            "photos": len(self.photos),
            "active_photos": active,
            "trashed_photos": trashed,
            "animals": len(self.animals),
            "taxa": len(self.taxa),
            "original_bytes": sum(photo.original_size_bytes for photo in self.photos),
        }
        if self.counts.model_dump() != actual_counts:
            raise ValueError("export counts do not match exported records")

        animal_ids = {animal.id for animal in self.animals}
        taxon_ids = {taxon.id for taxon in self.taxa}
        if any(
            photo.animal_id is not None and photo.animal_id not in animal_ids
            for photo in self.photos
        ):
            raise ValueError("photo references an Animal absent from the export")
        if any(
            animal.taxon_id is not None and animal.taxon_id not in taxon_ids
            for animal in self.animals
        ):
            raise ValueError("Animal references a Taxon absent from the export")

        paths = [photo.archive_relative_original_path for photo in self.photos]
        if len(paths) != len(set(paths)) or len(paths) != len(
            {path.casefold() for path in paths}
        ):
            raise ValueError("original paths must be unique without case collisions")
        return self
