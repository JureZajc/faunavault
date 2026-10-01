"""Shared strict types for user-authored Photo metadata."""

from typing import Annotated, Literal

from pydantic import Field

PhotoRating = Annotated[int, Field(strict=True, ge=1, le=5)]
PhotoCullingState = Literal["pick", "reject"]
CullingFilter = Literal["pick", "reject", "undecided"]
