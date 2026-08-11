from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from sqlmodel import select

from app.config import Settings
from app.db import SessionDep
from app.models import Photo
from app.schemas import (
    BatchUploadFailure,
    BatchUploadResponse,
    TrashMutationResponse,
    TrashPage,
)
from app.services.photo_lifecycle import (
    create_photo_from_upload,
    list_trash,
    move_to_trash,
    permanently_delete_photo,
    restore_photo,
)

logger = logging.getLogger(__name__)


def _batch_failure(filename: str, error: HTTPException) -> BatchUploadFailure:
    detail = error.detail if isinstance(error.detail, dict) else {}
    message = detail.get("message") if detail else error.detail
    return BatchUploadFailure(
        filename=filename,
        error=str(message or "Upload failed"),
        code=detail.get("code"),
        photo_id=detail.get("photo_id"),
        location=detail.get("location"),
    )


def create_photo_lifecycle_router(
    settings_provider: Callable[[], Settings],
) -> APIRouter:
    router = APIRouter()

    @router.post("/photos/upload", response_model=Photo)
    async def upload_photo(
        session: SessionDep,
        file: UploadFile = File(...),
    ) -> Photo:
        return await create_photo_from_upload(session, file, settings_provider())

    @router.post("/photos/upload-batch", response_model=BatchUploadResponse)
    async def upload_photo_batch(
        session: SessionDep,
        files: list[UploadFile] = File(...),
    ) -> BatchUploadResponse:
        uploaded: list[Photo] = []
        failed: list[BatchUploadFailure] = []
        for file in files:
            filename = Path(file.filename or "upload").name
            try:
                photo = await create_photo_from_upload(
                    session,
                    file,
                    settings_provider(),
                )
                uploaded.append(Photo(**photo.model_dump()))
            except HTTPException as exc:
                session.rollback()
                failed.append(_batch_failure(filename, exc))
            except Exception:
                session.rollback()
                logger.exception("Unexpected batch upload failure for %s", filename)
                failed.append(
                    BatchUploadFailure(filename=filename, error="Upload failed")
                )
        return BatchUploadResponse(uploaded=uploaded, failed=failed)

    @router.get("/photos", response_model=list[Photo])
    def list_photos(session: SessionDep) -> list[Photo]:
        return list(
            session.exec(
                select(Photo)
                .where(Photo.deleted_at.is_(None))
                .order_by(Photo.created_at.desc())
            ).all()
        )

    @router.delete("/photos/{photo_id}", response_model=TrashMutationResponse)
    def delete_photo(photo_id: int, session: SessionDep) -> TrashMutationResponse:
        return move_to_trash(photo_id, session)

    @router.get("/trash/photos", response_model=TrashPage)
    def get_trash_photos(
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=24, ge=1, le=100),
    ) -> TrashPage:
        return list_trash(session, page, page_size)

    @router.post(
        "/trash/photos/{photo_id}/restore",
        response_model=TrashMutationResponse,
    )
    def restore_trashed_photo(
        photo_id: int,
        session: SessionDep,
    ) -> TrashMutationResponse:
        return restore_photo(photo_id, session)

    @router.delete(
        "/trash/photos/{photo_id}",
        response_model=TrashMutationResponse,
    )
    def permanently_delete_trashed_photo(
        photo_id: int,
        session: SessionDep,
    ) -> TrashMutationResponse:
        return permanently_delete_photo(photo_id, session, settings_provider())

    return router
