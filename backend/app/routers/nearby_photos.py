from typing import Literal

from fastapi import APIRouter, Query

from app.db import SessionDep
from app.schemas import NearbyPhotosResponse
from app.services.nearby_photos import nearby_photos


def create_nearby_photos_router() -> APIRouter:
    router = APIRouter(prefix="/photos", tags=["photos"])

    @router.get("/{photo_id}/nearby", response_model=NearbyPhotosResponse)
    def get_nearby_photos(
        photo_id: int,
        session: SessionDep,
        radius_km: Literal["1", "5", "10", "25"] = "5",
        limit: int = Query(default=12, ge=1, le=24),
    ) -> NearbyPhotosResponse:
        return nearby_photos(session, photo_id, int(radius_km), limit)

    return router
