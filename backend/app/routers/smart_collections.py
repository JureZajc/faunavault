from __future__ import annotations

from fastapi import APIRouter, Query, status

from app.db import SessionDep
from app.schemas import (
    CatalogPhotoPage,
    SmartCollectionCreateRequest,
    SmartCollectionDeleteResponse,
    SmartCollectionRead,
    SmartCollectionSummaryRead,
    SmartCollectionUpdateRequest,
)
from app.services.smart_collections import (
    create_smart_collection,
    delete_smart_collection,
    get_smart_collection,
    list_smart_collection_photos,
    list_smart_collections,
    update_smart_collection,
)


def create_smart_collections_router() -> APIRouter:
    router = APIRouter(prefix="/smart-collections", tags=["smart-collections"])

    @router.get("", response_model=list[SmartCollectionSummaryRead])
    def get_all(session: SessionDep) -> list[SmartCollectionSummaryRead]:
        return list_smart_collections(session)

    @router.post(
        "", response_model=SmartCollectionRead, status_code=status.HTTP_201_CREATED
    )
    def create(
        request: SmartCollectionCreateRequest, session: SessionDep
    ) -> SmartCollectionRead:
        return create_smart_collection(request.name, request.query, session)

    @router.get("/{collection_id}", response_model=SmartCollectionRead)
    def get_one(collection_id: int, session: SessionDep) -> SmartCollectionRead:
        return get_smart_collection(collection_id, session)

    @router.patch("/{collection_id}", response_model=SmartCollectionRead)
    def update(
        collection_id: int, request: SmartCollectionUpdateRequest, session: SessionDep
    ) -> SmartCollectionRead:
        return update_smart_collection(collection_id, request, session)

    @router.delete("/{collection_id}", response_model=SmartCollectionDeleteResponse)
    def remove(
        collection_id: int, session: SessionDep
    ) -> SmartCollectionDeleteResponse:
        return delete_smart_collection(collection_id, session)

    @router.get("/{collection_id}/photos", response_model=CatalogPhotoPage)
    def get_photos(
        collection_id: int,
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=48, ge=1, le=100),
    ) -> CatalogPhotoPage:
        return list_smart_collection_photos(
            collection_id, session, page=page, page_size=page_size
        )

    return router
