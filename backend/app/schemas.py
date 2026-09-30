from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import HTTPException
from pydantic import (
    ConfigDict,
    StrictBool,
    field_validator,
    model_validator,
)
from pydantic import Field as PydanticField
from sqlmodel import Field, SQLModel

from app.catalog_query import CatalogSavedQuery
from app.metadata_types import PhotoRating
from app.models import Animal, DuplicateScanState, Photo

ALLOWED_PHOTO_STATUSES = {"pending", "classified", "needs_review"}
BulkPhotoOperation = Literal[
    "add_tags",
    "remove_tags",
    "set_category",
    "clear_category",
    "move_to_trash",
    "set_favorite",
    "set_rating",
    "clear_rating",
]


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
    model_config = ConfigDict(extra="forbid")

    display_title: str | None = None
    is_favorite: StrictBool = False
    rating: PhotoRating | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    category: str | None = None
    confidence: float | None = None
    description: str | None = None
    tags: list[str] | None = None
    status: str | None = None
    captured_at: datetime | None = None
    captured_at_offset_minutes: int | None = None
    latitude: float | None = None
    longitude: float | None = None
    restore_original_metadata: bool = False

    @field_validator("captured_at", mode="before")
    @classmethod
    def validate_capture_timestamp(cls, value: object) -> object:
        if value is None:
            return None
        if (
            not isinstance(value, str)
            or re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?", value)
            is None
        ):
            raise ValueError("capture timestamp must be a zone-free ISO date and time")
        return value

    @field_validator("captured_at_offset_minutes", mode="before")
    @classmethod
    def validate_capture_offset(cls, value: object) -> object:
        if value is not None and (type(value) is not int or not -1439 <= value <= 1439):
            raise ValueError("capture offset must be an integer from -1439 to 1439")
        return value

    @field_validator("latitude", "longitude", mode="before")
    @classmethod
    def validate_coordinate(cls, value: object) -> object:
        # FastAPI's default validation response cannot JSON-encode NaN/Infinity.
        # Reject these directly without echoing the invalid numeric input.
        if type(value) in (int, float):
            try:
                finite = math.isfinite(value)
            except OverflowError:
                finite = False
            if not finite:
                raise HTTPException(
                    status_code=422, detail="GPS coordinates must be finite numbers"
                )
        if value is not None and (
            type(value) not in (int, float) or not math.isfinite(value)
        ):
            raise ValueError("GPS coordinates must be finite numbers")
        return value

    @field_validator("restore_original_metadata", mode="before")
    @classmethod
    def validate_restore_flag(cls, value: object) -> object:
        if type(value) is not bool:
            raise ValueError("restore_original_metadata must be a boolean")
        return value

    @model_validator(mode="after")
    def validate_metadata(self) -> PhotoUpdate:
        capture_fields = {"captured_at", "captured_at_offset_minutes"}
        gps_fields = {"latitude", "longitude"}
        for group in (capture_fields, gps_fields):
            if self.model_fields_set & group and not group <= self.model_fields_set:
                raise ValueError(
                    "capture time/offset and GPS must each be complete groups"
                )
        if self.captured_at is None and self.captured_at_offset_minutes is not None:
            raise ValueError("capture offset requires captured_at")
        if (self.latitude is None) != (self.longitude is None):
            raise ValueError("GPS coordinates must both be present or both null")
        if self.latitude is not None and not -90 <= self.latitude <= 90:
            raise ValueError("latitude must be between -90 and 90")
        if self.longitude is not None and not -180 <= self.longitude <= 180:
            raise ValueError("longitude must be between -180 and 180")
        if self.restore_original_metadata and self.model_fields_set & (
            capture_fields | gps_fields
        ):
            raise ValueError("Restore cannot be combined with capture/GPS values")
        if self.confidence is not None and not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be null or between 0 and 1")
        if (
            "status" in self.model_fields_set
            and self.status not in ALLOWED_PHOTO_STATUSES
        ):
            allowed = ", ".join(sorted(ALLOWED_PHOTO_STATUSES))
            raise ValueError(f"status must be one of: {allowed}")
        return self


class ReviewInbox(SQLModel):
    total: int
    photo: Photo | None
    position: int | None
    previous_photo_id: int | None
    next_photo_id: int | None
    requested_photo_unavailable: bool
    low_confidence: bool


class DuplicateIdentity(SQLModel):
    left: int
    right: int


class DuplicateComparison(SQLModel):
    identity: DuplicateIdentity
    left_photo: Photo
    right_photo: Photo
    detector: str
    distance: int
    discovered_at: datetime


class DuplicateReview(SQLModel):
    pair: DuplicateComparison | None
    total: int
    previous: DuplicateIdentity | None = None
    next: DuplicateIdentity | None = None
    first: DuplicateIdentity | None = None
    requested_pair_unavailable: bool = False


class DuplicateDismissRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")
    detector: str
    expected_discovered_at: datetime


class DuplicateDismissResponse(SQLModel):
    identity: DuplicateIdentity
    dismissed_at: datetime
    remaining: int
    next: DuplicateIdentity | None = None


class DuplicateSummary(SQLModel):
    unresolved: int
    dismissed: int
    detector: str
    threshold: int
    scan: DuplicateScanState | None
    missing_fingerprints: int


class ReviewAcceptRequest(SQLModel):
    expected_updated_at: datetime


class ReviewAcceptResponse(SQLModel):
    accepted_photo_id: int
    remaining: int
    next_photo_id: int | None


class TaxonSelection(SQLModel):
    gbif_key: int = Field(ge=1)


class ReconcileRequest(SQLModel):
    limit: int = Field(default=50, ge=1, le=100)


class BatchUploadFailure(SQLModel):
    file_index: int
    filename: str
    error: str
    code: str | None = None
    photo_id: int | None = None
    location: str | None = None


class VisualDuplicateCandidate(SQLModel):
    photo_id: int
    original_filename: str
    display_title: str | None = None
    common_name: str | None = None
    species_guess: str | None = None
    location: Literal["catalog", "trash"]
    hamming_distance: int = Field(ge=0, le=64)


class PossibleVisualDuplicate(SQLModel):
    file_index: int
    filename: str
    message: str
    candidates: list[VisualDuplicateCandidate]


class BatchUploadResponse(SQLModel):
    uploaded: list[Photo]
    possible_duplicates: list[PossibleVisualDuplicate]
    failed: list[BatchUploadFailure]


class PhotoMapPoint(SQLModel):
    id: int
    latitude: float
    longitude: float
    thumbnail_filename: str
    original_filename: str
    display_title: str | None
    common_name: str | None
    species_guess: str | None
    captured_at: datetime | None


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


class ClassificationEnqueueRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")

    photo_ids: list[int]
    intent: Literal["classify_pending", "reclassify"] = "classify_pending"

    @field_validator("photo_ids")
    @classmethod
    def validate_photo_ids(cls, value: list[int]) -> list[int]:
        if not value:
            raise ValueError("photo_ids must not be empty")
        if any(photo_id < 1 for photo_id in value):
            raise ValueError("photo_ids must contain positive IDs")
        return list(dict.fromkeys(value))


class ClassificationJobRead(SQLModel):
    id: int
    photo_id: int
    status: str
    batch_id: str
    batch_kind: str
    requested_model: str
    fallback_model: str | None
    actual_model: str | None
    fallback_attempted: bool
    prompt_version: str
    attempt_count: int
    created_at: datetime
    queued_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    duration_ms: int | None
    failure_code: str | None
    failure_message: str | None
    classification_status: str | None
    photo_original_filename: str | None
    retryable: bool


class ClassificationEnqueuedItem(SQLModel):
    job: ClassificationJobRead
    created: bool


class ClassificationEnqueueRejection(SQLModel):
    photo_id: int
    code: str
    message: str


class ClassificationJobSummary(SQLModel):
    total: int
    queued: int
    running: int
    succeeded: int
    failed: int


class ClassificationEnqueueResponse(SQLModel):
    jobs: list[ClassificationEnqueuedItem]
    rejected: list[ClassificationEnqueueRejection]
    summary: ClassificationJobSummary


class ClassificationJobCollection(SQLModel):
    jobs: list[ClassificationJobRead]
    summary: ClassificationJobSummary


class TrashPage(SQLModel):
    items: list[Photo]
    total: int
    page: int
    page_size: int


class TrashMutationResponse(SQLModel):
    status: str
    photo_id: int
    missing_files: int = 0


class BulkPhotoRequestBase(SQLModel):
    model_config = ConfigDict(extra="forbid")

    photo_ids: list[int]


class BulkAddTagsRequest(BulkPhotoRequestBase):
    operation: Literal["add_tags"]
    tags: list[str]


class BulkRemoveTagsRequest(BulkPhotoRequestBase):
    operation: Literal["remove_tags"]
    tags: list[str]


class BulkSetCategoryRequest(BulkPhotoRequestBase):
    operation: Literal["set_category"]
    category: str


class BulkClearCategoryRequest(BulkPhotoRequestBase):
    operation: Literal["clear_category"]


class BulkSetFavoriteRequest(BulkPhotoRequestBase):
    operation: Literal["set_favorite"]
    is_favorite: StrictBool


class BulkSetRatingRequest(BulkPhotoRequestBase):
    operation: Literal["set_rating"]
    rating: PhotoRating


class BulkClearRatingRequest(BulkPhotoRequestBase):
    operation: Literal["clear_rating"]


class BulkMoveToTrashRequest(BulkPhotoRequestBase):
    operation: Literal["move_to_trash"]


BulkPhotoRequest = Annotated[
    BulkAddTagsRequest
    | BulkRemoveTagsRequest
    | BulkSetCategoryRequest
    | BulkClearCategoryRequest
    | BulkSetFavoriteRequest
    | BulkSetRatingRequest
    | BulkClearRatingRequest
    | BulkMoveToTrashRequest,
    PydanticField(discriminator="operation"),
]


class BulkPhotoMutationResponse(SQLModel):
    status: Literal["completed"] = "completed"
    operation: BulkPhotoOperation
    photo_ids: list[int]
    affected_count: int


class BulkPhotoErrorDetail(SQLModel):
    code: str
    message: str
    photo_ids: list[int] | None = None
    max_photo_ids: int | None = None


class CollectionCreateRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")

    name: str


class CollectionRenameRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")

    name: str


class CollectionMembershipRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")

    photo_ids: list[int]


class CollectionSummaryRead(SQLModel):
    id: int
    name: str
    active_photo_count: int
    created_at: datetime
    updated_at: datetime


class CollectionPhotoPage(SQLModel):
    items: list[Photo]
    total: int
    page: int
    page_size: int
    total_pages: int


class CollectionDetailRead(CollectionSummaryRead):
    photos: CollectionPhotoPage


class CollectionDeleteResponse(SQLModel):
    status: Literal["deleted"] = "deleted"
    collection_id: int


class CollectionAddPhotosResponse(SQLModel):
    collection_id: int
    requested_count: int
    added_count: int
    already_present_count: int


class CollectionRemovePhotosResponse(SQLModel):
    collection_id: int
    requested_count: int
    removed_count: int
    already_absent_count: int


class SmartCollectionCreateRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    query_version: Literal[1]
    query: CatalogSavedQuery


class SmartCollectionUpdateRequest(SQLModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    query_version: Literal[1] | None = None
    query: CatalogSavedQuery | None = None


class SmartCollectionSummaryRead(SQLModel):
    id: int
    name: str
    query_version: int
    query_valid: bool
    query_error: str | None
    created_at: datetime
    updated_at: datetime


class SmartCollectionRead(SmartCollectionSummaryRead):
    query: CatalogSavedQuery | None


class SmartCollectionDeleteResponse(SQLModel):
    status: Literal["deleted"] = "deleted"
    smart_collection_id: int


class CatalogStatusCounts(SQLModel):
    pending: int = 0
    classified: int = 0
    needs_review: int = 0


class CatalogCategoryFacet(SQLModel):
    value: str
    count: int


class CatalogFacets(SQLModel):
    active_total: int
    status_counts: CatalogStatusCounts
    categories: list[CatalogCategoryFacet]
    uncategorized_count: int


class CatalogPhotoPage(SQLModel):
    items: list[Photo]
    page: int
    page_size: int
    total: int
    total_pages: int
    facets: CatalogFacets


class TimelinePhotoPreview(SQLModel):
    id: int
    thumbnail_filename: str
    original_filename: str
    display_title: str | None


class TimelineMonth(SQLModel):
    month: int = Field(ge=1, le=12)
    photo_count: int = Field(ge=0)
    previews: list[TimelinePhotoPreview]


class TimelineYear(SQLModel):
    year: int
    photo_count: int = Field(ge=0)
    months: list[TimelineMonth]


class TimelineResponse(SQLModel):
    years: list[TimelineYear]
    unknown_capture_count: int = Field(ge=0)


class CatalogTaxonOption(SQLModel):
    taxon_id: int
    label: str
    scientific_name: str
    count: int


class CatalogTaxonPage(SQLModel):
    items: list[CatalogTaxonOption]
    selected: CatalogTaxonOption | None
    page: int
    page_size: int
    total: int
    total_pages: int


class AnimalTaxonResponse(SQLModel):
    animal: Animal
    taxon: dict


class TaxonCandidateRead(SQLModel):
    provider: str
    external_taxon_id: int
    scientific_name: str
    canonical_name: str
    common_name: str | None
    rank: str
    kingdom: str | None
    phylum: str | None
    taxonomic_class: str | None = Field(alias="class")
    taxonomic_order: str | None = Field(alias="order")
    family: str | None
    genus: str | None
    species: str | None
    cached: bool


class TaxonomySearchResponse(SQLModel):
    results: list[TaxonCandidateRead]
    external_available: bool
    warning: str | None


class ReconcileResponse(SQLModel):
    processed: int
    linked: int
    ambiguous: int
    unmatched: int
    failed: int


class AlbumSummaryRead(SQLModel):
    album_key: str
    verified: bool
    common_name: str | None
    scientific_name: str
    rank: str | None
    taxonomic_class: str | None = Field(alias="class")
    taxonomic_order: str | None = Field(alias="order")
    family: str | None
    genus: str | None
    species: str | None
    animal_count: int
    photo_count: int
    newest_at: datetime | None
    cover_photo_id: int | None
    cover_thumbnail_filename: str | None


class AlbumPage(SQLModel):
    items: list[AlbumSummaryRead]
    total: int
    page: int
    page_size: int


class AnimalPage(SQLModel):
    items: list[Animal]
    total: int
    page: int
    page_size: int


class AlbumPhotoPage(SQLModel):
    items: list[Photo]
    total: int
    page: int
    page_size: int


class AlbumDetailRead(AlbumSummaryRead):
    taxonomy: TaxonCandidateRead | None
    animals: AnimalPage
    photos: AlbumPhotoPage


class TaxonomyFilterOption(SQLModel):
    value: str
    count: int


class TaxonomyFiltersRead(SQLModel):
    classes: list[TaxonomyFilterOption]
    orders: list[TaxonomyFilterOption]
    families: list[TaxonomyFilterOption]
    genera: list[TaxonomyFilterOption]
    species: list[TaxonomyFilterOption]


class AlbumTaxonResponse(SQLModel):
    album_key: str
    updated_animals: int
    taxon: TaxonCandidateRead
