from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from app.catalog_query import CatalogSavedQuery
from app.db import SessionDep
from app.metadata_types import CullingFilter
from app.schemas import (
    CatalogFacets,
    CatalogPhotoPage,
    CatalogTaxonPage,
    CullingWorkspace,
    PhotoMapPoint,
    TimelineResponse,
)
from app.services.catalog import (
    culling_workspace,
    get_catalog_facets,
    get_photo_timeline,
    list_catalog_photos,
    list_catalog_taxa,
    list_photo_map_points,
)

RatingParameter = Literal["1", "2", "3", "4", "5"]


def _validated_query(**values) -> CatalogSavedQuery:
    try:
        return CatalogSavedQuery(**values)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()[0]["msg"]) from exc


def create_catalog_router() -> APIRouter:
    router = APIRouter(prefix="/catalog", tags=["catalog"])

    @router.get("/timeline", response_model=TimelineResponse)
    def get_timeline(session: SessionDep) -> TimelineResponse:
        return get_photo_timeline(session)

    @router.get("/facets", response_model=CatalogFacets)
    def get_facets(session: SessionDep) -> CatalogFacets:
        return get_catalog_facets(session)

    @router.get("/map", response_model=list[PhotoMapPoint])
    def get_photo_map_points(
        session: SessionDep,
        status: Literal["pending", "classified", "needs_review"] | None = None,
        category: str | None = Query(default=None, max_length=200),
        uncategorized: bool = False,
        taxon_id: int | None = Query(default=None, ge=1),
        taken_from: date | None = None,
        taken_to: date | None = None,
        search: str | None = Query(default=None, include_in_schema=False),
        favorites_only: bool = Query(default=False, include_in_schema=False),
        rating: RatingParameter | None = Query(default=None, include_in_schema=False),
        rating_min: RatingParameter | None = Query(
            default=None, include_in_schema=False
        ),
        unrated: bool = Query(default=False, include_in_schema=False),
        import_session_id: str | None = Query(default=None, include_in_schema=False),
        culling_state: CullingFilter | None = Query(
            default=None, include_in_schema=False
        ),
    ) -> list[PhotoMapPoint]:
        if import_session_id is not None:
            raise HTTPException(
                422, detail="Import Session filters are not supported on Map."
            )
        if culling_state is not None:
            raise HTTPException(
                status_code=422, detail="Culling filters are not supported on Map."
            )
        if favorites_only or rating is not None or rating_min is not None or unrated:
            raise HTTPException(
                status_code=422,
                detail="Favorite and rating filters are not supported on Map.",
            )
        if search and search.strip():
            raise HTTPException(
                status_code=422, detail="Text search is not supported on Map."
            )
        criteria = _validated_query(
            status=status,
            category=category,
            uncategorized=uncategorized,
            taxon_id=taxon_id,
            taken_from=taken_from,
            taken_to=taken_to,
        )
        return list_photo_map_points(session, criteria)

    @router.get("/photos", response_model=CatalogPhotoPage)
    def get_catalog_photos(
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=48, ge=1, le=100),
        search: str | None = Query(default=None, max_length=200),
        status: Literal["pending", "classified", "needs_review"] | None = None,
        category: str | None = Query(default=None, max_length=200),
        uncategorized: bool = False,
        taxon_id: int | None = Query(default=None, ge=1),
        taken_from: date | None = None,
        taken_to: date | None = None,
        favorites_only: bool = False,
        rating: RatingParameter | None = None,
        rating_min: RatingParameter | None = None,
        unrated: bool = False,
        culling_state: CullingFilter | None = None,
        import_session_id: str | None = None,
        sort: Literal[
            "created_at",
            "captured_at",
            "name",
            "species",
            "confidence",
            "rating",
            "needs_review",
            "pending",
        ] = "created_at",
        order: Literal["asc", "desc"] = "desc",
    ) -> CatalogPhotoPage:
        criteria = _validated_query(
            search=search,
            status=status,
            category=category,
            uncategorized=uncategorized,
            taxon_id=taxon_id,
            taken_from=taken_from,
            taken_to=taken_to,
            sort=sort,
            order=order,
            favorites_only=favorites_only,
            rating=int(rating) if rating is not None else None,
            rating_min=int(rating_min) if rating_min is not None else None,
            unrated=unrated,
            culling_state=culling_state,
            import_session_id=import_session_id,
        )
        return list_catalog_photos(
            session,
            page=page,
            page_size=page_size,
            **criteria.model_dump(),
        )

    @router.get("/culling", response_model=CullingWorkspace)
    def get_culling_workspace(
        session: SessionDep,
        photo_id: int | None = Query(default=None, ge=1),
        search: str | None = Query(default=None, max_length=200),
        status: Literal["pending", "classified", "needs_review"] | None = None,
        category: str | None = Query(default=None, max_length=200),
        uncategorized: bool = False,
        taxon_id: int | None = Query(default=None, ge=1),
        taken_from: date | None = None,
        taken_to: date | None = None,
        favorites_only: bool = False,
        rating: RatingParameter | None = None,
        rating_min: RatingParameter | None = None,
        unrated: bool = False,
        culling_state: CullingFilter | None = None,
        import_session_id: str | None = None,
        sort: Literal[
            "created_at",
            "captured_at",
            "name",
            "species",
            "confidence",
            "rating",
            "needs_review",
            "pending",
        ] = "created_at",
        order: Literal["asc", "desc"] = "desc",
    ) -> CullingWorkspace:
        criteria = _validated_query(
            search=search,
            status=status,
            category=category,
            uncategorized=uncategorized,
            taxon_id=taxon_id,
            taken_from=taken_from,
            taken_to=taken_to,
            favorites_only=favorites_only,
            rating=int(rating) if rating else None,
            rating_min=int(rating_min) if rating_min else None,
            unrated=unrated,
            culling_state=culling_state,
            import_session_id=import_session_id,
            sort=sort,
            order=order,
        )
        return culling_workspace(session, criteria, photo_id)

    @router.get("/taxa", response_model=CatalogTaxonPage)
    def get_catalog_taxa(
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=50, ge=1, le=100),
        include_id: int | None = Query(default=None, ge=1),
    ) -> CatalogTaxonPage:
        return list_catalog_taxa(
            session,
            page=page,
            page_size=page_size,
            include_id=include_id,
        )

    return router
