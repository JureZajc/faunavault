from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.clients.gbif import (
    GBIF_UNAVAILABLE_DETAIL,
    GbifClientDep,
    GbifClientError,
)
from app.db import SessionDep
from app.schemas import (
    ReconcileRequest,
    ReconcileResponse,
    TaxonomySearchResponse,
)
from app.services.taxonomy import reconcile_taxonomy, search_taxonomy


def create_taxonomy_router() -> APIRouter:
    router = APIRouter(prefix="/taxonomy", tags=["taxonomy"])

    @router.get("/search", response_model=TaxonomySearchResponse)
    def search(
        session: SessionDep,
        client: GbifClientDep,
        q: str = Query(min_length=2, max_length=120),
        limit: int = Query(default=12, ge=1, le=30),
    ) -> dict:
        query = q.strip()
        if len(query) < 2:
            raise HTTPException(
                status_code=422,
                detail="Search query must contain at least 2 non-whitespace characters",
            )
        try:
            return search_taxonomy(session, client, query, limit)
        except GbifClientError as exc:
            raise HTTPException(
                status_code=503,
                detail=GBIF_UNAVAILABLE_DETAIL,
            ) from exc

    @router.post("/reconcile", response_model=ReconcileResponse)
    def reconcile(
        request: ReconcileRequest,
        session: SessionDep,
        client: GbifClientDep,
    ) -> dict:
        return reconcile_taxonomy(session, client, request.limit)

    return router
