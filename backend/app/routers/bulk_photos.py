from __future__ import annotations

from fastapi import APIRouter

from app.db import SessionDep
from app.schemas import BulkPhotoMutationResponse, BulkPhotoRequest
from app.services.bulk_photos import apply_bulk_photo_action


def create_bulk_photos_router() -> APIRouter:
    router = APIRouter(prefix="/photos", tags=["photos"])

    @router.post("/bulk", response_model=BulkPhotoMutationResponse)
    def bulk_update_photos(
        request: BulkPhotoRequest,
        session: SessionDep,
    ) -> BulkPhotoMutationResponse:
        return apply_bulk_photo_action(request, session)

    return router
