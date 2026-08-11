from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, Column, UniqueConstraint
from sqlmodel import Field, SQLModel


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
    taxonomy_status: str = Field(default="unreviewed", index=True)
    taxonomy_note: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


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
    original_size_bytes: int | None = None
    media_type: str | None = None
    deleted_at: datetime | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
