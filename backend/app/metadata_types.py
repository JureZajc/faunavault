"""Shared types for Photo metadata."""

from typing import Annotated, Literal

from pydantic import Field

SHOOTING_SETTING_FIELDS = (
    "aperture_f_number",
    "exposure_time_seconds",
    "iso_speed",
    "focal_length_mm",
)
MAX_SQLITE_INTEGER = 2**63 - 1
PositiveMeasurement = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]
PositiveISO = Annotated[int, Field(strict=True, gt=0, le=MAX_SQLITE_INTEGER)]

PhotoRating = Annotated[int, Field(strict=True, ge=1, le=5)]
PhotoCullingState = Literal["pick", "reject"]
CullingFilter = Literal["pick", "reject", "undecided"]
