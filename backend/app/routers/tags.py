from fastapi import APIRouter, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from app.db import SessionDep
from app.schemas import (
    TagOperationApplyRequest,
    TagOperationPreview,
    TagOperationRequest,
    TagOperationResult,
)
from app.services.tag_operations import apply_tag_operation, preview_tag_operation


class TagOperationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def validated(request: Request):
            try:
                return await handler(request)
            except RequestValidationError as exc:
                raise HTTPException(
                    422,
                    detail={
                        "code": "invalid_tag_operation",
                        "message": "; ".join(error["msg"] for error in exc.errors()),
                    },
                ) from exc

        return validated


def create_tags_router() -> APIRouter:
    router = APIRouter(
        prefix="/tags/operations", tags=["tags"], route_class=TagOperationRoute
    )

    @router.post("/preview", response_model=TagOperationPreview)
    def preview(request: TagOperationRequest, session: SessionDep):
        return preview_tag_operation(session, request)

    @router.post("/apply", response_model=TagOperationResult)
    def apply(request: TagOperationApplyRequest, session: SessionDep):
        return apply_tag_operation(session, request)

    return router
