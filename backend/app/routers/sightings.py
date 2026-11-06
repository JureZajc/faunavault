from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query
from sqlmodel import Session

from app.db import SessionDep
from app.services import sightings
from app.sighting_schemas import (
    SightingCreate,
    SightingJournalPage,
    SightingMembership,
    SightingOrder,
    SightingPage,
    SightingPhotoPage,
    SightingRead,
    SightingSelection,
    SightingTaxonPage,
    SightingUpdate,
)

Identity = Annotated[int, Path(ge=1, le=2**63 - 1)]
Page = Annotated[int, Query(ge=1, le=2**31 - 1)]
PageSize = Annotated[int, Query(ge=1, le=100)]


def _read_snapshot(session: SessionDep) -> Session:
    # Explicitly start a read transaction so counts, rows and previews agree.
    session.connection().exec_driver_sql("BEGIN")
    return session


ReadSession = Annotated[Session, Depends(_read_snapshot)]


def create_sightings_router() -> APIRouter:
    router = APIRouter(tags=["sightings"])

    @router.get("/sightings", response_model=SightingJournalPage)
    def index(
        session: ReadSession,
        date_from: date | None = None,
        date_to: date | None = None,
        taxon_id: int | None = Query(None, ge=1, le=2**63 - 1),
        sort: SightingOrder = "newest",
        page: Page = 1,
        page_size: PageSize = 24,
    ):
        return sightings.list_sightings(
            session,
            date_from=date_from,
            date_to=date_to,
            taxon_id=taxon_id,
            newest=sort == "newest",
            page=page,
            page_size=page_size,
        )

    @router.get("/sightings/taxa", response_model=SightingTaxonPage)
    def taxa(
        session: SessionDep, search: str = Query("", max_length=200), page: Page = 1
    ):
        return sightings.list_taxa(session, search=search, page=page)

    @router.post("/sightings/selection", response_model=SightingSelection)
    def selection(request: SightingMembership, session: SessionDep):
        return sightings.describe_selection(session, request.photo_ids)

    @router.post("/sightings", response_model=SightingRead, status_code=201)
    def create(request: SightingCreate, session: SessionDep):
        return sightings.create_sighting(session, request)

    @router.get("/sightings/{sighting_id}", response_model=SightingRead)
    def detail(session: ReadSession, sighting_id: Identity):
        return sightings.get_sighting(session, sighting_id)

    @router.patch("/sightings/{sighting_id}", response_model=SightingRead)
    def update(request: SightingUpdate, session: SessionDep, sighting_id: Identity):
        return sightings.update_sighting(session, sighting_id, request)

    @router.delete("/sightings/{sighting_id}")
    def remove(session: SessionDep, sighting_id: Identity):
        sightings.delete_sighting(session, sighting_id)
        return {"status": "deleted", "sighting_id": sighting_id}

    @router.get("/sightings/{sighting_id}/photos", response_model=SightingPhotoPage)
    def photos(
        session: ReadSession,
        sighting_id: Identity,
        page: Page = 1,
        page_size: PageSize = 24,
    ):
        return sightings.list_photos(
            session, sighting_id, page=page, page_size=page_size
        )

    @router.post("/sightings/{sighting_id}/photos", response_model=SightingRead)
    def add_photos(
        request: SightingMembership, session: SessionDep, sighting_id: Identity
    ):
        return sightings.change_membership(
            session, sighting_id, request.photo_ids, adding=True
        )

    @router.delete("/sightings/{sighting_id}/photos", response_model=SightingRead)
    def remove_photos(
        request: SightingMembership, session: SessionDep, sighting_id: Identity
    ):
        return sightings.change_membership(
            session, sighting_id, request.photo_ids, adding=False
        )

    @router.get("/photos/{photo_id}/sightings", response_model=SightingPage)
    def photo_sightings(
        session: ReadSession,
        photo_id: Identity,
        page: Page = 1,
        page_size: PageSize = 12,
    ):
        return sightings.list_photo_sightings(
            session, photo_id, page=page, page_size=page_size
        )

    return router
