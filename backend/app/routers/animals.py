from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.clients.gbif import (
    GBIF_UNAVAILABLE_DETAIL,
    GbifClientDep,
    GbifClientError,
)
from app.db import SessionDep
from app.models import Animal, utc_now
from app.schemas import AnimalTaxonResponse, AnimalUpdate, TaxonSelection
from app.services.taxonomy import AnimalNotFoundError, assign_animal_taxon


def _animal_or_404(animal_id: int, session: SessionDep) -> Animal:
    animal = session.get(Animal, animal_id)
    if animal is None:
        raise HTTPException(status_code=404, detail="Animal not found")
    return animal


def create_animals_router() -> APIRouter:
    router = APIRouter(prefix="/animals", tags=["animals"])

    @router.get("/{animal_id}", response_model=Animal)
    def get_animal(animal_id: int, session: SessionDep) -> Animal:
        return _animal_or_404(animal_id, session)

    @router.patch("/{animal_id}", response_model=Animal)
    def update_animal(
        animal_id: int,
        update: AnimalUpdate,
        session: SessionDep,
    ) -> Animal:
        animal = _animal_or_404(animal_id, session)
        if "display_name" not in update.model_fields_set:
            return animal
        animal.display_name = update.display_name
        animal.updated_at = utc_now()
        session.add(animal)
        session.commit()
        session.refresh(animal)
        return animal

    @router.put("/{animal_id}/taxon", response_model=AnimalTaxonResponse)
    def select_animal_taxon(
        animal_id: int,
        selection: TaxonSelection,
        session: SessionDep,
        client: GbifClientDep,
    ) -> dict:
        try:
            return assign_animal_taxon(
                session,
                client,
                animal_id,
                selection.gbif_key,
            )
        except AnimalNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Animal not found") from exc
        except GbifClientError as exc:
            raise HTTPException(
                status_code=503,
                detail=GBIF_UNAVAILABLE_DETAIL,
            ) from exc
        except (RuntimeError, SQLAlchemyError) as exc:
            session.rollback()
            raise HTTPException(
                status_code=500,
                detail="Taxonomy update failed",
            ) from exc

    return router
