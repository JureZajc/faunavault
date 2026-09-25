from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.config import Settings
from app.db import SessionDep
from app.schemas import ReviewAcceptRequest, ReviewAcceptResponse, ReviewInbox
from app.services.review import accept_review, review_inbox


def create_review_router(settings_provider) -> APIRouter:
    router = APIRouter(prefix="/review", tags=["review"])

    @router.get("", response_model=ReviewInbox)
    def get_review_inbox(session: SessionDep, photo: int | None = None) -> ReviewInbox:
        settings: Settings = settings_provider()
        return review_inbox(session, photo, settings.ai_confidence_threshold)

    @router.post("/photos/{photo_id}/accept", response_model=ReviewAcceptResponse)
    def accept_photo(
        photo_id: int, payload: ReviewAcceptRequest, session: SessionDep
    ) -> ReviewAcceptResponse:
        result = accept_review(session, photo_id, payload.expected_updated_at)
        if result is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "review_conflict",
                    "message": "This photo changed or is no longer available for review. Refresh the inbox.",
                },
            )
        return result

    return router
