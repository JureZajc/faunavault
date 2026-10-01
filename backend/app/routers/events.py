from fastapi import APIRouter, Path, Query

from app.db import SessionDep
from app.event_schemas import (
    EventAddResponse,
    EventDeleteResponse,
    EventDetail,
    EventFields,
    EventKind,
    EventMembershipRequest,
    EventPage,
    EventRemoveResponse,
    EventUpdate,
)
from app.services.events import (
    change_membership,
    create_event,
    delete_event,
    get_event,
    list_events,
    update_event,
)


def create_events_router() -> APIRouter:
    router = APIRouter(prefix="/events", tags=["events"])

    @router.get("", response_model=EventPage)
    def index(
        session: SessionDep,
        kind: EventKind | None = None,
        page: int = Query(1, ge=1),
        page_size: int = Query(24, ge=1, le=100),
    ):
        return list_events(session, kind=kind, page=page, page_size=page_size)

    @router.post("", response_model=EventDetail, status_code=201)
    def create(request: EventFields, session: SessionDep):
        return create_event(request, session)

    @router.get("/{event_id}", response_model=EventDetail)
    def detail(session: SessionDep, event_id: int = Path(ge=1, le=2**63 - 1)):
        return get_event(event_id, session)

    @router.patch("/{event_id}", response_model=EventDetail)
    def update(
        request: EventUpdate,
        session: SessionDep,
        event_id: int = Path(ge=1, le=2**63 - 1),
    ):
        return update_event(event_id, request, session)

    @router.delete("/{event_id}", response_model=EventDeleteResponse)
    def remove(session: SessionDep, event_id: int = Path(ge=1, le=2**63 - 1)):
        return delete_event(event_id, session)

    @router.post("/{event_id}/photos", response_model=EventAddResponse)
    def add_photos(
        request: EventMembershipRequest,
        session: SessionDep,
        event_id: int = Path(ge=1, le=2**63 - 1),
    ):
        return change_membership(event_id, request.photo_ids, session, adding=True)

    @router.delete("/{event_id}/photos", response_model=EventRemoveResponse)
    def remove_photos(
        request: EventMembershipRequest,
        session: SessionDep,
        event_id: int = Path(ge=1, le=2**63 - 1),
    ):
        return change_membership(event_id, request.photo_ids, session, adding=False)

    return router
