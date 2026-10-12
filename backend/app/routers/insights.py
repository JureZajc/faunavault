from fastapi import APIRouter, Query

from app.db import SessionDep
from app.insights_schemas import InsightsResponse
from app.services.insights import get_insights


def create_insights_router() -> APIRouter:
    router = APIRouter(prefix="/insights", tags=["insights"])

    @router.get("", response_model=InsightsResponse)
    def read_insights(
        session: SessionDep, year: int | None = Query(default=None, ge=1, le=9999)
    ):
        """Active photos only. Year scopes every metric; All Time includes undated photos.

        Year options are global. All Time activity is yearly; select a year for
        twelve zero-filled months. Percentages use the scoped active photo total.
        """
        return get_insights(session, year)

    return router
