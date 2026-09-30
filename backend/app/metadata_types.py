"""Shared strict types for user-authored Photo metadata."""

from typing import Annotated

from pydantic import Field

PhotoRating = Annotated[int, Field(strict=True, ge=1, le=5)]
