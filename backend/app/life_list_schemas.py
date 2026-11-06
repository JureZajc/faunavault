from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas import TimelinePhotoPreview

LifeListMode = Literal["seen", "new"]
LifeListOrder = Literal["name", "first_observed", "most_observed"]


class LifeListTaxon(BaseModel):
    taxon_id: int
    common_name: str | None
    scientific_name: str
    taxonomic_rank: str
    first_observed_at: datetime
    last_observed_at: datetime
    sighting_count: int
    first_sighting_id: int
    last_sighting_id: int
    preview: TimelinePhotoPreview | None


class LifeListSummary(BaseModel):
    all_time_taxa: int
    all_time_sightings: int
    seen_taxa: int | None
    new_taxa: int | None
    scope_sightings: int


class LifeListPage(BaseModel):
    items: list[LifeListTaxon]
    total: int
    page: int
    page_size: int
    total_pages: int
    year: int | None
    available_years: list[int]
    summary: LifeListSummary
