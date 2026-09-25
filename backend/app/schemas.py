from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import (
    ConfigDict,
    field_validator,
    model_validator,
)
from pydantic import Field as PydanticField
from sqlmodel import Field, SQLModel

from app.catalog_query import CatalogSavedQuery
from app.models import Animal, Photo

ALLOWED_PHOTO_STATUSES = {"pending", "classified", "needs_review"}
BulkPhotoOperation = Literal[
    "add_tags",
    "remove_tags",
    "set_category",
    "clear_category",
    "move_to_trash",
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


class ReviewInbox(SQLModel):
    total: int
    photo: Photo | None
    position: int | None
    previous_photo_id: int | None
    next_photo_id: int | None
    requested_photo_unavailable: bool
    low_confidence: bool


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


class BulkMoveToTrashRequest(BulkPhotoRequestBase):
    operation: Literal["move_to_trash"]


BulkPhotoRequest = Annotated[
    BulkAddTagsRequest
    | BulkRemoveTagsRequest
    | BulkSetCategoryRequest
    | BulkClearCategoryRequest
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
