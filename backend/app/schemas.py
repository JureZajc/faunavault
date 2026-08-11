from __future__ import annotations

from pydantic import ConfigDict, field_validator, model_validator
from sqlmodel import Field, SQLModel

from app.models import Animal, Photo

ALLOWED_PHOTO_STATUSES = {"pending", "classified", "needs_review"}


class AnimalUpdate(SQLModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=100)

    @field_validator("display_name", mode="before")
    @classmethod
    def normalize_display_name(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip()
        return normalized or None


class PhotoUpdate(SQLModel):
    display_title: str | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    category: str | None = None
    confidence: float | None = None
    description: str | None = None
    tags: list[str] | None = None
    status: str | None = None

    @model_validator(mode="after")
    def validate_metadata(self) -> PhotoUpdate:
        if self.confidence is not None and not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be null or between 0 and 1")
        if (
            "status" in self.model_fields_set
            and self.status not in ALLOWED_PHOTO_STATUSES
        ):
            allowed = ", ".join(sorted(ALLOWED_PHOTO_STATUSES))
            raise ValueError(f"status must be one of: {allowed}")
        return self


class TaxonSelection(SQLModel):
    gbif_key: int


class ReconcileRequest(SQLModel):
    limit: int = Field(default=50, ge=1, le=100)


class BatchUploadFailure(SQLModel):
    filename: str
    error: str
    code: str | None = None
    photo_id: int | None = None
    location: str | None = None


class BatchUploadResponse(SQLModel):
    uploaded: list[Photo]
    failed: list[BatchUploadFailure]


class ClassifyPendingRequest(SQLModel):
    limit: int | None = None
    photo_ids: list[int] | None = None

    @model_validator(mode="after")
    def validate_request(self) -> ClassifyPendingRequest:
        if self.limit is not None and self.limit < 1:
            raise ValueError("limit must be greater than 0")
        if self.photo_ids is not None and any(
            photo_id < 1 for photo_id in self.photo_ids
        ):
            raise ValueError("photo_ids must contain positive IDs")
        return self


class ClassifyPendingPhotoResult(SQLModel):
    id: int
    status: str
    display_title: str | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    error: str | None = None


class ClassifyPendingResponse(SQLModel):
    total_found: int
    classified: int
    needs_review: int
    failed: int
    results: list[ClassifyPendingPhotoResult]


class TrashPage(SQLModel):
    items: list[Photo]
    total: int
    page: int
    page_size: int


class TrashMutationResponse(SQLModel):
    status: str
    photo_id: int
    missing_files: int = 0


class AnimalTaxonResponse(SQLModel):
    animal: Animal
    taxon: dict
