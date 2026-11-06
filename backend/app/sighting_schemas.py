from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import Photo
from app.schemas import TimelinePhotoPreview

SightingOrder = Literal["newest", "oldest"]
SPECIES_RANKS = ("SPECIES", "SUBSPECIES")
PositiveId = Annotated[int, Field(strict=True, ge=1, le=2**63 - 1)]
Offset = Annotated[int, Field(strict=True, ge=-1439, le=1439)]
Latitude = Annotated[float, Field(strict=True, ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)]
Subject = Annotated[str, Field(max_length=100)]
Location = Annotated[str, Field(max_length=200)]
Notes = Annotated[str, Field(max_length=2000)]


class SightingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subject_label: Subject | None = None
    taxon_id: PositiveId | None = None
    observed_at: datetime | None = None
    observed_at_offset_minutes: Offset | None = None
    latitude: Latitude | None = None
    longitude: Longitude | None = None
    location_label: Location | None = None
    notes: Notes | None = None

    @field_validator("subject_label", "location_label", "notes", mode="before")
    @classmethod
    def optional_text(cls, value: object) -> object:
        if isinstance(value, str):
            if "\0" in value:
                raise ValueError("Text cannot contain a null character")
            return value.strip() or None
        return value

    @field_validator("observed_at", mode="before")
    @classmethod
    def local_datetime(cls, value: object) -> object:
        if isinstance(value, datetime) and value.tzinfo is None:
            return value
        if isinstance(value, str) and re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?",
            value,
        ):
            return value
        raise ValueError("Use a field-local date and time without a UTC offset")

    @model_validator(mode="after")
    def provided_fields(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one observation field")
        return self


class SightingFields(SightingUpdate):
    observed_at: datetime

    @model_validator(mode="after")
    def coordinate_pair(self):
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError(
                "Latitude and longitude must both be provided or both be empty"
            )
        return self


class SightingMembership(BaseModel):
    model_config = ConfigDict(extra="forbid")

    photo_ids: list[PositiveId] = Field(min_length=1, max_length=250)

    @field_validator("photo_ids")
    @classmethod
    def unique_ids(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value):
            raise ValueError("Photo IDs must not contain duplicates")
        return value


class SightingCreate(SightingFields, SightingMembership):
    pass


class SightingTaxon(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    provider: str
    external_taxon_id: str
    scientific_name: str
    canonical_name: str
    common_name: str | None
    taxonomic_rank: str


class SightingTaxonPage(BaseModel):
    items: list[SightingTaxon]
    has_more: bool


class SightingRead(SightingFields):
    id: int
    created_at: datetime
    updated_at: datetime
    taxon: SightingTaxon | None
    active_photo_count: int
    trash_photo_count: int
    preview: TimelinePhotoPreview | None

    @field_validator("created_at", "updated_at")
    @classmethod
    def utc_timestamps(cls, value: datetime) -> datetime:
        return (
            value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        )


class SightingTotals(BaseModel):
    recorded: int
    in_date_range: int
    verified: int
    unidentified: int


class SightingPage(BaseModel):
    items: list[SightingRead]
    total: int
    page: int
    page_size: int
    total_pages: int


class SightingJournalPage(SightingPage):
    totals: SightingTotals


class SightingPhotoPage(BaseModel):
    items: list[Photo]
    total: int
    page: int
    page_size: int
    total_pages: int


class SightingSelection(BaseModel):
    photo_count: int
    previews: list[TimelinePhotoPreview]
    observed_at: datetime | None
    observed_at_offset_minutes: int | None
    latitude: float | None
    longitude: float | None
    capture_times_differ: bool
