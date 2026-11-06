from __future__ import annotations

import re
from datetime import date
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

from app.geographic_bounds import validate_bounding_box
from app.metadata_types import (
    SHOOTING_SETTING_FIELDS,
    CullingFilter,
    PhotoRating,
    PositiveISO,
    PositiveMeasurement,
)
from app.services.import_sessions import canonical_session_id
from app.tag_values import normalize_tags

CatalogStatus = Literal["pending", "classified", "needs_review"]
CatalogSort = Literal[
    "created_at",
    "captured_at",
    "name",
    "species",
    "confidence",
    "rating",
    "needs_review",
    "pending",
]
CatalogOrder = Literal["asc", "desc"]
MetadataIssue = Literal[
    "missing_capture", "missing_gps", "missing_both", "missing_either", "complete"
]


class CatalogSavedQuery(BaseModel):
    """Version-one persisted catalog criteria; pagination and layout are separate."""

    model_config = ConfigDict(extra="forbid", strict=True)

    search: str | None = Field(default=None, max_length=200)
    import_session_id: str | None = None
    status: CatalogStatus | None = None
    category: str | None = Field(default=None, max_length=200)
    uncategorized: bool = False
    taxon_id: int | None = Field(default=None, ge=1)
    taken_from: date | None = Field(default=None, strict=False)
    taken_to: date | None = Field(default=None, strict=False)
    favorites_only: bool = False
    culling_state: CullingFilter | None = None
    rating: PhotoRating | None = None
    rating_min: PhotoRating | None = None
    unrated: bool = False
    sort: CatalogSort = "created_at"
    order: CatalogOrder = "desc"

    @field_validator("search", "category")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator("import_session_id")
    @classmethod
    def validate_import_id(cls, value: str | None) -> str | None:
        return canonical_session_id(value) if value is not None else None

    @field_validator("taken_from", "taken_to", mode="before")
    @classmethod
    def validate_date_input(cls, value: object) -> object:
        if value is None or isinstance(value, date):
            return value
        if isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return value
        raise ValueError("capture dates must use YYYY-MM-DD")

    @model_validator(mode="after")
    def validate_combinations(self) -> CatalogSavedQuery:
        if (
            sum((self.rating is not None, self.rating_min is not None, self.unrated))
            > 1
        ):
            raise ValueError("rating, rating_min and unrated cannot be combined")
        if self.category and self.uncategorized:
            raise ValueError("category and uncategorized cannot be combined")
        if self.taken_from and self.taken_to and self.taken_from > self.taken_to:
            raise ValueError("taken_from must be on or before taken_to")
        return self


class CatalogSavedQueryV2(CatalogSavedQuery):
    """Persistable live catalog criteria, excluding Trip/Event membership."""

    metadata_issue: MetadataIssue | None = None
    bbox_south: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    bbox_north: float | None = Field(default=None, ge=-90, le=90, allow_inf_nan=False)
    bbox_west: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)
    bbox_east: float | None = Field(default=None, ge=-180, le=180, allow_inf_nan=False)

    @model_validator(mode="after")
    def validate_bounds(self) -> CatalogSavedQueryV2:
        validate_bounding_box(
            self.bbox_south, self.bbox_north, self.bbox_west, self.bbox_east
        )
        return self

    tags: list[str] = Field(default_factory=list, max_length=20)
    untagged: bool = False
    # Empty strings explicitly select a missing component of a partial identity.
    camera_make: str | None = Field(default=None, max_length=1000)
    camera_model: str | None = Field(default=None, max_length=1000)
    lens_model: str | None = Field(default=None, max_length=1000)
    unknown_camera: bool = False
    unknown_lens: bool = False

    @field_validator("camera_make", "camera_model", "lens_model")
    @classmethod
    def trim_equipment(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def validate_equipment(self) -> CatalogSavedQueryV2:
        if self.unknown_camera and (
            self.camera_make is not None or self.camera_model is not None
        ):
            raise ValueError("camera criteria and unknown_camera cannot be combined")
        if self.unknown_lens and self.lens_model is not None:
            raise ValueError("lens_model and unknown_lens cannot be combined")
        return self

    @field_validator("tags")
    @classmethod
    def normalize_filter_tags(cls, value: list[str]) -> list[str]:
        if any(len(tag) > 1000 for tag in value):
            raise ValueError("tag filters must be at most 1000 characters each")
        return normalize_tags(value)

    @model_validator(mode="after")
    def validate_tag_filters(self) -> CatalogSavedQueryV2:
        if self.tags and self.untagged:
            raise ValueError("tags and untagged cannot be combined")
        return self


class CatalogQuery(CatalogSavedQueryV2):
    """Live criteria including Trip/Event membership and shooting settings."""

    event_id: int | None = Field(default=None, ge=1, le=2**63 - 1)
    iso_speed_min: PositiveISO | None = None
    iso_speed_max: PositiveISO | None = None
    aperture_f_number_min: PositiveMeasurement | None = None
    aperture_f_number_max: PositiveMeasurement | None = None
    focal_length_mm_min: PositiveMeasurement | None = None
    focal_length_mm_max: PositiveMeasurement | None = None
    exposure_time_seconds_min: PositiveMeasurement | None = None
    exposure_time_seconds_max: PositiveMeasurement | None = None

    def shooting_ranges(self):
        for field in SHOOTING_SETTING_FIELDS:
            minimum = getattr(self, f"{field}_min")
            maximum = getattr(self, f"{field}_max")
            if minimum is not None or maximum is not None:
                yield field, minimum, maximum

    @model_validator(mode="after")
    def validate_shooting_ranges(self) -> CatalogQuery:
        for field, minimum, maximum in self.shooting_ranges():
            if minimum is not None and maximum is not None and minimum > maximum:
                raise ValueError(
                    f"{field}_min must be less than or equal to {field}_max"
                )
        return self


def saved_query_model(version: int) -> type[CatalogSavedQuery]:
    if type(version) is int:
        if version == 1:
            return CatalogSavedQuery
        if version == 2:
            return CatalogSavedQueryV2
    raise ValueError(f"Unsupported saved query version {version}.")


def _strict_query_version(version: object) -> object:
    if type(version) is not int:
        raise ValueError("query_version must be an integer")
    return version


def _validate_versioned_query(value: object, info: ValidationInfo) -> object:
    version = info.data.get("query_version")
    if version is None:
        # PATCH handles missing version/query pairs with its existing API error.
        return value
    if isinstance(value, BaseModel):
        value = value.model_dump()
    return saved_query_model(version).model_validate(value)


SavedQueryVersion = Annotated[Literal[1, 2], BeforeValidator(_strict_query_version)]
SavedQuery = CatalogSavedQueryV2 | CatalogSavedQuery
# In request and export models, query_version must be declared before query.
VersionedSavedQuery = Annotated[SavedQuery, BeforeValidator(_validate_versioned_query)]
