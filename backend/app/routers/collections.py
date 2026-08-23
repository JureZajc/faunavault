from __future__ import annotations

from fastapi import APIRouter, Query, status

from app.db import SessionDep
from app.schemas import (
    CollectionAddPhotosResponse,
    CollectionCreateRequest,
    CollectionDeleteResponse,
    CollectionDetailRead,
    CollectionMembershipRequest,
    CollectionRemovePhotosResponse,
    CollectionRenameRequest,
    CollectionSummaryRead,
)
from app.services.collections import (
    add_collection_photos,
    create_collection,
    delete_collection,
    get_collection_detail,
    list_collections,
    remove_collection_photos,
    rename_collection,
)


def create_collections_router() -> APIRouter:
    router = APIRouter(prefix="/collections", tags=["collections"])

    @router.get("", response_model=list[CollectionSummaryRead])
    def get_collections(session: SessionDep) -> list[CollectionSummaryRead]:
        return list_collections(session)

    @router.post(
        "",
        response_model=CollectionSummaryRead,
        status_code=status.HTTP_201_CREATED,
    )
    def post_collection(
        request: CollectionCreateRequest,
        session: SessionDep,
    ) -> CollectionSummaryRead:
        return create_collection(request.name, session)

    @router.get("/{collection_id}", response_model=CollectionDetailRead)
    def get_collection(
        collection_id: int,
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=48, ge=1, le=100),
    ) -> CollectionDetailRead:
        return get_collection_detail(
            collection_id,
            session,
            page=page,
            page_size=page_size,
        )

    @router.patch("/{collection_id}", response_model=CollectionSummaryRead)
    def patch_collection(
        collection_id: int,
        request: CollectionRenameRequest,
        session: SessionDep,
    ) -> CollectionSummaryRead:
        return rename_collection(collection_id, request.name, session)

    @router.delete("/{collection_id}", response_model=CollectionDeleteResponse)
    def remove_collection(
        collection_id: int,
        session: SessionDep,
    ) -> CollectionDeleteResponse:
        return delete_collection(collection_id, session)

    @router.post(
        "/{collection_id}/photos",
        response_model=CollectionAddPhotosResponse,
    )
    def add_photos(
        collection_id: int,
        request: CollectionMembershipRequest,
        session: SessionDep,
    ) -> CollectionAddPhotosResponse:
        return add_collection_photos(collection_id, request.photo_ids, session)

    @router.delete(
        "/{collection_id}/photos",
        response_model=CollectionRemovePhotosResponse,
    )
    def remove_photos(
        collection_id: int,
        request: CollectionMembershipRequest,
        session: SessionDep,
    ) -> CollectionRemovePhotosResponse:
        return remove_collection_photos(collection_id, request.photo_ids, session)

    return router
