"""Bounded, photo-based analytics; all percentages use the scoped active total."""

from pydantic import BaseModel


class InsightsCoverage(BaseModel):
    known: int
    missing: int
    percentage: float


class InsightsOverview(BaseModel):
    total_photos: int
    verified_species: int
    favorites: int
    picks: int
    rejects: int
    unverified_photos: int
    other_taxon_rank_photos: int
    gps: InsightsCoverage
    capture_dates: InsightsCoverage


class InsightsPeriod(BaseModel):
    period: int
    photo_count: int


class InsightsSpecies(BaseModel):
    taxon_id: int
    common_name: str | None
    scientific_name: str
    photo_count: int
    percentage: float


class InsightsDistribution(BaseModel):
    value: str | None
    label: str
    photo_count: int
    percentage: float
    other: bool = False


class InsightsCamera(BaseModel):
    camera_make: str | None
    camera_model: str | None
    photo_count: int
    percentage: float


class InsightsLens(BaseModel):
    lens_model: str
    photo_count: int
    percentage: float


class InsightsEquipment(BaseModel):
    camera: InsightsCoverage
    lens: InsightsCoverage
    top_cameras: list[InsightsCamera]
    top_lenses: list[InsightsLens]


class InsightsResponse(BaseModel):
    year: int | None
    overview: InsightsOverview
    available_years: list[int]
    monthly: list[InsightsPeriod]
    yearly: list[InsightsPeriod]
    top_species: list[InsightsSpecies]
    categories: list[InsightsDistribution]
    classification: list[InsightsDistribution]
    equipment: InsightsEquipment | None = None
