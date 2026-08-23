from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from app.db import SessionDep
from app.schemas import CatalogPhotoPage, CatalogTaxonPage, PhotoMapPoint
from app.services.catalog import (
    list_catalog_photos,
    list_catalog_taxa,
    list_photo_map_points,
)


def create_catalog_router() -> APIRouter:
    router = APIRouter(prefix="/catalog", tags=["catalog"])

    @router.get("/map", response_model=list[PhotoMapPoint])
    def get_photo_map_points(session: SessionDep) -> list[PhotoMapPoint]:
        return list_photo_map_points(session)

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
        sort: Literal[
            "created_at",
            "captured_at",
            "name",
            "species",
            "confidence",
            "needs_review",
            "pending",
        ] = "created_at",
        order: Literal["asc", "desc"] = "desc",
    ) -> CatalogPhotoPage:
        normalized_category = category.strip() if category else None
        if normalized_category and uncategorized:
            raise HTTPException(
                status_code=422,
                detail="category and uncategorized cannot be combined",
            )
        if taken_from is not None and taken_to is not None and taken_from > taken_to:
            raise HTTPException(
                status_code=422,
                detail="taken_from must be on or before taken_to",
            )
        return list_catalog_photos(
            session,
            page=page,
            page_size=page_size,
            search=search,
            status=status,
            category=normalized_category,
            uncategorized=uncategorized,
            taxon_id=taxon_id,
            taken_from=taken_from,
            taken_to=taken_to,
            sort=sort,
            order=order,
        )

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
