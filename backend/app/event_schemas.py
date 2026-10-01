from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas import TimelinePhotoPreview

EventKind = Literal["trip", "event"]


class EventFields(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: EventKind
    title: str = Field(max_length=100)
    start_date: date
    end_date: date
    location_label: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=2000)

    @field_validator("title", mode="before")
    @classmethod
    def title_text(cls, value: str) -> str:
        if not isinstance(value, str):
            return value
        value = " ".join(value.split())
        if not value:
            raise ValueError("Title must not be empty")
        return value

    @field_validator("location_label", "notes", mode="before")
    @classmethod
    def optional_text(cls, value: str | None) -> str | None:
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def date_input(cls, value: object) -> object:
        if type(value) is date or (
            isinstance(value, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)
        ):
            return value
        raise ValueError("Dates must use YYYY-MM-DD")

    @model_validator(mode="after")
    def dates_ordered(self):
        if self.start_date > self.end_date:
            raise ValueError("Start date must be on or before end date")
        return self


class EventUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: EventKind | None = None
    title: str | None = None
    start_date: date | None = None
    end_date: date | None = None
    location_label: str | None = None
    notes: str | None = None

    _dates = field_validator("start_date", "end_date", mode="before")(
        EventFields.date_input.__func__
    )

    @model_validator(mode="after")
    def provided_fields(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one metadata field")
        if any(
            getattr(self, name) is None
            for name in self.model_fields_set
            & {"kind", "title", "start_date", "end_date"}
        ):
            raise ValueError("Kind, title and dates cannot be null")
        return self


class EventSummary(BaseModel):
    id: int
    kind: EventKind
    title: str
    start_date: date
    end_date: date
    location_label: str | None
    created_at: datetime
    updated_at: datetime
    active_photo_count: int = 0
    previews: list[TimelinePhotoPreview] = Field(default_factory=list)


class EventDetail(EventSummary):
    notes: str | None
    trash_photo_count: int = 0
    undecided_count: int = 0
    pick_count: int = 0
    reject_count: int = 0


class EventPage(BaseModel):
    items: list[EventSummary]
    total: int
    page: int
    page_size: int
    total_pages: int


class EventMembershipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    photo_ids: list[Annotated[int, Field(ge=1, le=2**63 - 1)]]


class EventAddResponse(BaseModel):
    event_id: int
    requested_count: int
    added_count: int
    already_present_count: int


class EventRemoveResponse(BaseModel):
    event_id: int
    requested_count: int
    removed_count: int
    already_absent_count: int


class EventDeleteResponse(BaseModel):
    status: Literal["deleted"] = "deleted"
    event_id: int
