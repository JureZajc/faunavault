from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import Session

from app.album_identity import parse_album_key
from app.db import SessionDep
from app.models import Taxon
from app.schemas import (
    AlbumDetailRead,
    AlbumPage,
    AlbumTaxonResponse,
    TaxonomyFiltersRead,
    TaxonSelection,
)
from app.services.albums import (
    AlbumAlreadyVerifiedError,
    AlbumNotFoundError,
    assign_album_taxon,
    get_album_detail,
    list_albums,
    taxonomy_filters,
)


def _identity_or_404(album_key: str):
    identity = parse_album_key(album_key)
    if identity is None:
        raise HTTPException(status_code=404, detail="Species album not found")
    return identity


def create_albums_router(
    persist_taxon: Callable[[Session, int], Taxon],
) -> APIRouter:
    router = APIRouter(tags=["albums"])

    @router.get("/taxonomy/filters", response_model=TaxonomyFiltersRead)
    def get_taxonomy_filters(session: SessionDep):
        return taxonomy_filters(session)

    @router.get("/species-albums", response_model=AlbumPage)
    def get_species_albums(
        session: SessionDep,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=24, ge=1, le=100),
        q: str = "",
        taxonomic_class: str | None = Query(default=None, alias="class"),
        order: str | None = None,
        family: str | None = None,
        genus: str | None = None,
        species: str | None = None,
        only_with_photos: bool = False,
        sort: Literal["name", "newest", "animal_count", "photo_count"] = "name",
    ):
        return list_albums(
            session,
            page=page,
            page_size=page_size,
            query=q,
            taxonomic_class=taxonomic_class,
            order=order,
            family=family,
            genus=genus,
            species=species,
            only_with_photos=only_with_photos,
            sort=sort,
        )

    @router.get("/species-albums/{album_key}", response_model=AlbumDetailRead)
    def get_species_album(
        album_key: str,
        session: SessionDep,
        animal_page: int = Query(default=1, ge=1),
        animal_page_size: int = Query(default=50, ge=1, le=100),
        photo_page: int = Query(default=1, ge=1),
        photo_page_size: int = Query(default=24, ge=1, le=100),
    ):
        try:
            return get_album_detail(
                session,
                _identity_or_404(album_key),
                animal_page=animal_page,
                animal_page_size=animal_page_size,
                photo_page=photo_page,
                photo_page_size=photo_page_size,
            )
        except AlbumNotFoundError as exc:
            raise HTTPException(
                status_code=404, detail="Species album not found"
            ) from exc

    @router.put(
        "/species-albums/{album_key}/taxon",
        response_model=AlbumTaxonResponse,
    )
    def select_album_taxon(
        album_key: str,
        selection: TaxonSelection,
        session: SessionDep,
    ):
        try:
            return assign_album_taxon(
                session,
                _identity_or_404(album_key),
                selection.gbif_key,
                persist_taxon,
            )
        except AlbumNotFoundError as exc:
            raise HTTPException(
                status_code=404, detail="Species album not found"
            ) from exc
        except AlbumAlreadyVerifiedError as exc:
            raise HTTPException(
                status_code=409,
                detail="Album already has verified taxonomy",
            ) from exc

    return router
