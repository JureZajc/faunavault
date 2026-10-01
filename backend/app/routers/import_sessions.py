from uuid import UUID

from fastapi import APIRouter, Query

from app.db import SessionDep
from app.services.import_sessions import (
    ImportSessionOutcomes,
    ImportSessionPage,
    ImportSessionRead,
    ImportSessionStart,
    complete_import_session,
    list_import_sessions,
    read_import_session,
    start_import_session,
)


def create_import_sessions_router() -> APIRouter:
    router = APIRouter(prefix="/import-sessions", tags=["imports"])

    @router.post("", response_model=ImportSessionRead)
    def start(request: ImportSessionStart, session: SessionDep):
        item = start_import_session(session, "browser_upload", session_id=request.id)
        return read_import_session(session, item.id)

    @router.post("/{session_id}/complete", response_model=ImportSessionRead)
    def complete(session_id: UUID, request: ImportSessionOutcomes, session: SessionDep):
        complete_import_session(
            session, str(session_id), request, source_kind="browser_upload"
        )
        return read_import_session(session, str(session_id))

    @router.get("", response_model=ImportSessionPage)
    def index(
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=24, ge=1, le=100),
    ):
        return list_import_sessions(session, page, page_size)

    @router.get("/{session_id}", response_model=ImportSessionRead)
    def detail(session_id: UUID, session: SessionDep):
        return read_import_session(session, str(session_id))

    return router
