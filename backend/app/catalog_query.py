from __future__ import annotations

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CatalogStatus = Literal["pending", "classified", "needs_review"]
CatalogSort = Literal[
    "created_at",
    "captured_at",
    "name",
    "species",
    "confidence",
    "needs_review",
    "pending",
]
CatalogOrder = Literal["asc", "desc"]


class CatalogSavedQuery(BaseModel):
    """Version-one persisted catalog criteria; pagination and layout are separate."""

    model_config = ConfigDict(extra="forbid", strict=True)

    search: str | None = Field(default=None, max_length=200)
    status: CatalogStatus | None = None
    category: str | None = Field(default=None, max_length=200)
    uncategorized: bool = False
    taxon_id: int | None = Field(default=None, ge=1)
    taken_from: date | None = Field(default=None, strict=False)
    taken_to: date | None = Field(default=None, strict=False)
    sort: CatalogSort = "created_at"
    order: CatalogOrder = "desc"

    @field_validator("search", "category")
    @classmethod
    def normalize_text(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

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
        if self.category and self.uncategorized:
            raise ValueError("category and uncategorized cannot be combined")
        if self.taken_from and self.taken_to and self.taken_from > self.taken_to:
            raise ValueError("taken_from must be on or before taken_to")
        return self
