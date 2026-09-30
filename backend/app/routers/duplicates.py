from fastapi import APIRouter, HTTPException, Query

from app.db import SessionDep
from app.schemas import (
    DuplicateDismissRequest,
    DuplicateDismissResponse,
    DuplicateReview,
    DuplicateSummary,
)
from app.services.duplicate_review import dismiss, review, summary


def create_duplicates_router() -> APIRouter:
    router = APIRouter(prefix="/duplicates", tags=["duplicates"])

    @router.get("/summary", response_model=DuplicateSummary)
    def get_summary(session: SessionDep):
        return summary(session)

    @router.get("/review", response_model=DuplicateReview)
    def get_review(
        session: SessionDep,
        left: int | None = Query(None, ge=1),
        right: int | None = Query(None, ge=1),
    ):
        if (left is None) != (right is None) or (left is not None and left >= right):
            raise HTTPException(
                422, detail="Provide a canonical left < right pair, or omit both IDs."
            )
        # Keep count, pair evidence and Photo metadata in one read snapshot.
        session.connection().exec_driver_sql("BEGIN")
        return review(session, left, right)

    @router.post(
        "/pairs/{left}/{right}/dismiss", response_model=DuplicateDismissResponse
    )
    def keep_both(
        left: int, right: int, request: DuplicateDismissRequest, session: SessionDep
    ):
        return dismiss(session, left, right, request)

    return router
