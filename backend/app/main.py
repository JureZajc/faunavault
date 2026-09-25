import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import update
from sqlmodel import Session

from app.clients.gbif import GbifClient
from app.config import BACKEND_DIR, get_settings
from app.db import engine, get_session
from app.migrations import migrate_animals_and_taxonomy
from app.models import Animal, Photo, Taxon, utc_now
from app.ollama_client import OllamaClient
from app.routers.albums import create_albums_router
from app.routers.animals import create_animals_router
from app.routers.bulk_photos import create_bulk_photos_router
from app.routers.catalog import create_catalog_router
from app.routers.classification import create_classification_router
from app.routers.collections import create_collections_router
from app.routers.photo_lifecycle import create_photo_lifecycle_router
from app.routers.review import create_review_router
from app.routers.smart_collections import create_smart_collections_router
from app.routers.taxonomy import create_taxonomy_router
from app.schemas import PhotoUpdate
from app.services.classification import (
    apply_domestic_metadata_normalization,
    normalize_metadata_text,
    normalize_tags,
)
from app.services.classification import (
    normalize_existing_domestic_metadata as normalize_domestic_metadata,
)
from app.services.classification_jobs import (
    ClassificationWorker,
    recover_interrupted_jobs,
)
from app.services.image_variants import encoding_for_filename
from app.services.perceptual_duplicates import run_perceptual_hash_backfill
from app.services.photo_lifecycle import active_photo_or_404
from app.services.review import record_manual_photo_change
from app.storage_startup import initialize_archive_storage

__all__ = ["Animal", "Photo", "Taxon", "app", "migrate_animals_and_taxonomy"]

logger = logging.getLogger(__name__)
settings = get_settings()
DATABASE_PATH = settings.database_path or BACKEND_DIR / "data" / "faunavault.db"
DATABASE_URL = settings.resolved_database_url
IMAGE_ROOT = settings.image_dir
IMAGE_DIRS = settings.image_dirs

ALLOWED_IMAGE_TYPES = set(IMAGE_DIRS)


async def _run_perceptual_hash_backfill() -> None:
    try:
        await run_perceptual_hash_backfill(engine, settings)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Perceptual hash backfill stopped after an unexpected failure")


@asynccontextmanager
async def lifespan(application: FastAPI):
    on_startup()
    client_factory = getattr(application.state, "gbif_client_factory", None)
    gbif_client = (
        client_factory()
        if client_factory is not None
        else GbifClient(settings.gbif_base_url)
    )
    application.state.gbif_client = gbif_client
    worker = None
    managed_worker = False
    worker_started = False
    backfill_task = None
    ollama_client = None
    try:
        ollama_client_factory = getattr(
            application.state, "ollama_client_factory", None
        )
        ollama_client = (
            ollama_client_factory()
            if ollama_client_factory is not None
            else OllamaClient(
                settings.ollama_base_url,
                connect_timeout_seconds=settings.ollama_connect_timeout_seconds,
                request_timeout_seconds=settings.ollama_request_timeout_seconds,
                keep_alive=settings.ollama_keep_alive,
            )
        )
        application.state.ollama_client = ollama_client
        recover_interrupted_jobs(engine)
        backfill_task = asyncio.create_task(
            _run_perceptual_hash_backfill(),
            name="perceptual-hash-backfill",
        )
        worker = getattr(application.state, "classification_worker", None)
        managed_worker = worker is None
        if worker is None:
            worker = ClassificationWorker(engine, settings, ollama_client=ollama_client)
            application.state.classification_worker = worker
        await worker.start()
        worker_started = True
        yield
    finally:
        try:
            if backfill_task is not None:
                backfill_task.cancel()
                try:
                    await backfill_task
                except asyncio.CancelledError:
                    pass
        finally:
            try:
                if worker_started and worker is not None:
                    await worker.stop()
            finally:
                if managed_worker and hasattr(
                    application.state, "classification_worker"
                ):
                    del application.state.classification_worker
                try:
                    if ollama_client is not None:
                        ollama_client.close()
                finally:
                    if (
                        ollama_client is not None
                        and getattr(application.state, "ollama_client", None)
                        is ollama_client
                    ):
                        del application.state.ollama_client
                    try:
                        gbif_client.close()
                    finally:
                        if (
                            getattr(application.state, "gbif_client", None)
                            is gbif_client
                        ):
                            del application.state.gbif_client


app = FastAPI(title="FaunaVault API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def on_startup() -> None:
    initialize_archive_storage(engine, settings)


SessionDep = Annotated[Session, Depends(get_session)]
app.include_router(create_photo_lifecycle_router(lambda: settings))
app.include_router(create_bulk_photos_router())
app.include_router(create_catalog_router())
app.include_router(create_collections_router())
app.include_router(create_smart_collections_router())
app.include_router(create_classification_router(lambda: settings))
app.include_router(create_albums_router())
app.include_router(create_taxonomy_router())
app.include_router(create_animals_router())
app.include_router(create_review_router(lambda: settings))


def photo_or_404(photo_id: int, session: Session) -> Photo:
    return active_photo_or_404(photo_id, session)


def normalize_existing_domestic_metadata() -> None:
    normalize_domestic_metadata(engine)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/photos/{photo_id}", response_model=Photo)
def get_photo(photo_id: int, session: SessionDep) -> Photo:
    return photo_or_404(photo_id, session)


@app.patch("/photos/{photo_id}", response_model=Photo)
def update_photo(
    photo_id: int,
    metadata: PhotoUpdate,
    session: SessionDep,
    expected_updated_at: str | None = None,
) -> Photo:
    photo = photo_or_404(photo_id, session)
    if (
        expected_updated_at is not None
        and photo.updated_at.isoformat() != expected_updated_at
    ):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "photo_changed",
                "message": "Photo changed. Refresh before saving.",
            },
        )
    updates = metadata.model_dump(exclude_unset=True)
    if not updates:
        return photo

    tracked = (
        "display_title",
        "common_name",
        "breed_guess",
        "species_guess",
        "category",
        "confidence",
        "description",
        "tags",
        "status",
    )
    before = tuple(getattr(photo, name) for name in tracked)
    before_updated_at = photo.updated_at
    original_status = photo.status

    for field_name, value in updates.items():
        if field_name == "tags":
            photo.tags = normalize_tags(value)
        elif field_name in {
            "display_title",
            "common_name",
            "breed_guess",
            "species_guess",
            "category",
            "description",
        }:
            setattr(photo, field_name, normalize_metadata_text(value))
        else:
            setattr(photo, field_name, value)

    apply_domestic_metadata_normalization(photo)
    after = tuple(getattr(photo, name) for name in tracked)
    if after == before:
        return photo
    record_manual_photo_change(
        photo,
        utc_now(),
        resolve_review=original_status == "needs_review" and after[:-1] != before[:-1],
    )
    if expected_updated_at is not None:
        values = {name: getattr(photo, name) for name in tracked}
        values["reviewed_at"] = photo.reviewed_at
        values["updated_at"] = photo.updated_at
        session.expunge(photo)
        result = session.exec(
            update(Photo)
            .where(
                Photo.id == photo_id,
                Photo.deleted_at.is_(None),
                Photo.updated_at == before_updated_at,
            )
            .values(**values)
        )
        if result.rowcount != 1:
            session.rollback()
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "photo_changed",
                    "message": "Photo changed. Refresh before saving.",
                },
            )
        session.commit()
        return photo_or_404(photo_id, session)
    session.add(photo)
    session.commit()
    session.refresh(photo)
    return photo


@app.post("/photos/{photo_id}/mock-classify", response_model=Photo)
def mock_classify_photo(photo_id: int, session: SessionDep) -> Photo:
    photo = photo_or_404(photo_id, session)
    photo.display_title = "Domestic cat"
    photo.common_name = "cat"
    photo.breed_guess = None
    photo.species_guess = "Felis catus"
    photo.category = "mammal"
    photo.confidence = 0.88
    photo.description = "A small domestic cat visible in the uploaded photo."
    photo.tags = ["cat", "pet", "mammal"]
    apply_domestic_metadata_normalization(photo)
    photo.status = "classified"
    photo.reviewed_at = None
    photo.updated_at = utc_now()
    session.add(photo)
    session.commit()
    session.refresh(photo)
    return photo


@app.get("/images/{image_type}/{filename}")
def get_image(image_type: str, filename: str) -> FileResponse:
    if image_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=404, detail="Image type not found")

    safe_filename = Path(filename).name
    image_path = IMAGE_DIRS[image_type] / safe_filename
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    encoding = encoding_for_filename(safe_filename)
    return FileResponse(
        image_path,
        media_type=encoding.media_type if encoding is not None else None,
    )
