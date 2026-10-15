from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter

from app.config import Settings
from app.db import SessionDep
from app.schemas import (
    BulkCaptureApplyRequest,
    BulkCaptureApplyResponse,
    BulkCapturePreviewRequest,
    BulkCapturePreviewResponse,
    BulkPhotoMutationResponse,
    BulkPhotoRequest,
)
from app.services.bulk_capture_metadata import (
    apply_bulk_capture_metadata,
    preview_bulk_capture_metadata,
)
from app.services.bulk_photos import apply_bulk_photo_action


def create_bulk_photos_router(get_settings: Callable[[], Settings]) -> APIRouter:
    router = APIRouter(prefix="/photos", tags=["photos"])

    @router.post("/bulk/capture-preview", response_model=BulkCapturePreviewResponse)
    def capture_preview(request: BulkCapturePreviewRequest, session: SessionDep):
        return preview_bulk_capture_metadata(request, session, get_settings())

    @router.post("/bulk/capture-apply", response_model=BulkCaptureApplyResponse)
    def capture_apply(request: BulkCaptureApplyRequest, session: SessionDep):
        return apply_bulk_capture_metadata(request, session, get_settings())

    @router.post("/bulk", response_model=BulkPhotoMutationResponse)
    def bulk_update_photos(
        request: BulkPhotoRequest,
        session: SessionDep,
    ) -> BulkPhotoMutationResponse:
        return apply_bulk_photo_action(request, session)

    return router
