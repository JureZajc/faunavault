from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    event,
)
from sqlmodel import Field, SQLModel

from app.album_identity import normalize_legacy_species_group


def utc_now() -> datetime:
    return datetime.now(UTC)


class Taxon(SQLModel, table=True):
    __table_args__ = (
        UniqueConstraint("provider", "external_taxon_id", name="uq_taxon_provider_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    provider: str = Field(default="gbif", index=True)
    external_taxon_id: str = Field(index=True)
    scientific_name: str
    canonical_name: str
    common_name: str | None = None
    taxonomic_rank: str
    kingdom: str | None = Field(default=None, index=True)
    phylum: str | None = None
    taxonomic_class: str | None = Field(default=None, index=True)
    taxonomic_order: str | None = Field(default=None, index=True)
    family: str | None = Field(default=None, index=True)
    genus: str | None = Field(default=None, index=True)
    species: str | None = Field(default=None, index=True)
    synchronized_at: datetime = Field(default_factory=utc_now)


class Animal(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    identifier: str = Field(index=True, unique=True)
    display_name: str | None = None
    taxon_id: int | None = Field(default=None, foreign_key="taxon.id", index=True)
    legacy_common_name: str | None = None
    legacy_species_name: str | None = Field(default=None, index=True)
    legacy_species_group: str = Field(
        default_factory=lambda: normalize_legacy_species_group(None),
        sa_column=Column(
            String,
            nullable=False,
            server_default=normalize_legacy_species_group(None),
        ),
    )
    taxonomy_status: str = Field(default="unreviewed", index=True)
    taxonomy_note: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


@event.listens_for(Animal, "before_insert")
@event.listens_for(Animal, "before_update")
def synchronize_legacy_species_group(_mapper, _connection, animal: Animal) -> None:
    animal.legacy_species_group = normalize_legacy_species_group(
        animal.legacy_species_name
    )


class Photo(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    original_filename: str
    stored_filename: str
    resized_filename: str
    thumbnail_filename: str
    display_title: str | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    category: str | None = None
    confidence: float | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = "pending"
    animal_id: int | None = Field(default=None, foreign_key="animal.id", index=True)
    content_sha256: str | None = Field(default=None, index=True)
    perceptual_hash: str | None = Field(
        default=None,
        exclude=True,
        sa_column=Column(String(16), nullable=True),
    )
    original_size_bytes: int | None = None
    media_type: str | None = None
    captured_at: datetime | None = None
    captured_at_offset_minutes: int | None = Field(
        default=None,
        sa_column=Column(
            Integer,
            CheckConstraint(
                "captured_at_offset_minutes BETWEEN -1439 AND 1439",
                name="ck_photo_capture_offset_range",
            ),
            nullable=True,
        ),
    )
    camera_make: str | None = Field(
        default=None, sa_column=Column(String(200), nullable=True)
    )
    camera_model: str | None = Field(
        default=None, sa_column=Column(String(200), nullable=True)
    )
    lens_model: str | None = Field(
        default=None, sa_column=Column(String(200), nullable=True)
    )
    image_width: int | None = Field(
        default=None,
        sa_column=Column(
            Integer,
            CheckConstraint("image_width > 0", name="ck_photo_image_width_positive"),
            nullable=True,
        ),
    )
    image_height: int | None = Field(
        default=None,
        sa_column=Column(
            Integer,
            CheckConstraint("image_height > 0", name="ck_photo_image_height_positive"),
            nullable=True,
        ),
    )
    latitude: float | None = Field(
        default=None,
        sa_column=Column(
            Float,
            CheckConstraint(
                "latitude BETWEEN -90 AND 90", name="ck_photo_latitude_range"
            ),
            nullable=True,
        ),
    )
    longitude: float | None = Field(
        default=None,
        sa_column=Column(
            Float,
            CheckConstraint(
                "longitude BETWEEN -180 AND 180", name="ck_photo_longitude_range"
            ),
            nullable=True,
        ),
    )
    deleted_at: datetime | None = Field(default=None, index=True)
    reviewed_at: datetime | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


@event.listens_for(Photo, "before_insert")
@event.listens_for(Photo, "before_update")
def validate_capture_metadata(_mapper, _connection, photo: Photo) -> None:
    if (photo.image_width is None) != (photo.image_height is None):
        raise ValueError("image dimensions must be both present or both null")
    if (photo.latitude is None) != (photo.longitude is None):
        raise ValueError("latitude and longitude must be both present or both null")
    if photo.captured_at is None and photo.captured_at_offset_minutes is not None:
        raise ValueError("capture offset requires captured_at")


class Collection(SQLModel, table=True):
    __tablename__ = "collection"
    __table_args__ = (
        CheckConstraint(
            "length(name) BETWEEN 1 AND 100", name="ck_collection_name_length"
        ),
        CheckConstraint(
            "length(name_key) >= 1", name="ck_collection_name_key_nonempty"
        ),
        UniqueConstraint("name_key", name="uq_collection_name_key"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str
    name_key: str = Field(exclude=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class CollectionPhoto(SQLModel, table=True):
    __tablename__ = "collection_photo"
    __table_args__ = (
        Index("ix_collection_photo_photo_collection", "photo_id", "collection_id"),
    )

    collection_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("collection.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        )
    )
    photo_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("photo.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        )
    )


class SmartCollection(SQLModel, table=True):
    __tablename__ = "smart_collection"
    __table_args__ = (
        CheckConstraint(
            "length(name) BETWEEN 1 AND 100", name="ck_smart_collection_name_length"
        ),
        CheckConstraint(
            "length(name_key) >= 1", name="ck_smart_collection_name_key_nonempty"
        ),
        CheckConstraint("query_version >= 1", name="ck_smart_collection_query_version"),
        UniqueConstraint("name_key", name="uq_smart_collection_name_key"),
    )

    id: int | None = Field(default=None, primary_key=True)
    name: str
    name_key: str = Field(exclude=True)
    query_version: int = 1
    query_json: str
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class ClassificationJob(SQLModel, table=True):
    __tablename__ = "classification_job"

    id: int | None = Field(default=None, primary_key=True)
    photo_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("photo.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    status: str = Field(default="queued")
    batch_id: str
    batch_kind: str
    requested_model: str
    fallback_model: str | None = None
    actual_model: str | None = None
    fallback_attempted: bool = False
    prompt_version: str
    attempt_count: int = 1
    created_at: datetime = Field(default_factory=utc_now)
    queued_at: datetime = Field(default_factory=utc_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    duration_ms: int | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    classification_status: str | None = None
    source_photo_updated_at: datetime
