from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query

from app.db import SessionDep
from app.schemas import CatalogPhotoPage, CatalogTaxonPage
from app.services.catalog import list_catalog_photos, list_catalog_taxa


def create_catalog_router() -> APIRouter:
    router = APIRouter(prefix="/catalog", tags=["catalog"])

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
        sort: Literal[
            "created_at",
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
        return list_catalog_photos(
            session,
            page=page,
            page_size=page_size,
            search=search,
            status=status,
            category=normalized_category,
            uncategorized=uncategorized,
            taxon_id=taxon_id,
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
