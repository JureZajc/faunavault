from collections.abc import Callable

from fastapi import APIRouter, Response
from fastapi.responses import StreamingResponse

from app.archive_integrity import CHUNK_SIZE
from app.config import Settings
from app.db import SessionDep
from app.services.selected_photo_export import (
    PreparedExport,
    SelectedExportRequest,
    estimate_export,
    exports,
    prepare_export,
)


class ExportDownloadResponse(StreamingResponse):
    def __init__(self, artifact: PreparedExport):
        self.artifact = artifact
        super().__init__(
            iter(lambda: artifact.file.read(CHUNK_SIZE), b""),
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="FaunaVault-Export.zip"',
                "Content-Length": str(artifact.size),
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
            },
        )

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                self.artifact.close()
            finally:
                exports.slots.release()


def create_selected_export_router(get_settings: Callable[[], Settings]) -> APIRouter:
    router = APIRouter(prefix="/exports/selected", tags=["selected photo export"])

    @router.post("/estimate")
    def estimate(
        request: SelectedExportRequest, session: SessionDep, response: Response
    ):
        response.headers["Cache-Control"] = "no-store"
        return estimate_export(request, session, get_settings())

    @router.post("")
    def prepare(
        request: SelectedExportRequest, session: SessionDep, response: Response
    ):
        response.headers["Cache-Control"] = "no-store"
        return prepare_export(request, session, get_settings())

    @router.get("/{token}")
    def download(token: str):
        return ExportDownloadResponse(exports.take(token))

    return router
