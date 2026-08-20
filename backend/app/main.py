import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlmodel import Session, SQLModel

from app.clients.gbif import GbifClient
from app.config import BACKEND_DIR, get_settings
from app.db import engine, get_session
from app.migrations import (
    backup_database_before_taxonomy_migration,
    migrate_animals_and_taxonomy,
    run_migrations,
)
from app.models import Animal, Photo, Taxon, utc_now
from app.routers.albums import create_albums_router
from app.routers.animals import create_animals_router
from app.routers.catalog import create_catalog_router
from app.routers.classification import create_classification_router
from app.routers.photo_lifecycle import create_photo_lifecycle_router
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
from app.services.perceptual_duplicates import run_perceptual_hash_backfill
from app.services.photo_lifecycle import active_photo_or_404, reconcile_purge_journal
from app.services.photo_lifecycle import (
    ensure_storage as ensure_lifecycle_storage,
)

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
    try:
        recover_interrupted_jobs(engine)
        backfill_task = asyncio.create_task(
            _run_perceptual_hash_backfill(),
            name="perceptual-hash-backfill",
        )
        worker = getattr(application.state, "classification_worker", None)
        managed_worker = worker is None
        if worker is None:
            worker = ClassificationWorker(engine, settings)
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
                    gbif_client.close()
                finally:
                    if getattr(application.state, "gbif_client", None) is gbif_client:
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


def ensure_storage() -> None:
    ensure_lifecycle_storage(settings)


def ensure_photo_metadata_columns() -> None:
    with engine.begin() as connection:
        columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(photo)"))
        }
        for column_name in ("display_title", "breed_guess"):
            if column_name not in columns:
                connection.execute(
                    text(f"ALTER TABLE photo ADD COLUMN {column_name} TEXT")
                )


def on_startup() -> None:
    ensure_storage()
    backup_database_before_taxonomy_migration(engine)
    SQLModel.metadata.create_all(
        engine, tables=[Taxon.__table__, Animal.__table__, Photo.__table__]
    )
    migrate_animals_and_taxonomy(engine)
    run_migrations(engine, settings, normalize_existing_domestic_metadata)
    with Session(engine) as session:
        reconcile_purge_journal(session, settings)


SessionDep = Annotated[Session, Depends(get_session)]
app.include_router(create_photo_lifecycle_router(lambda: settings))
app.include_router(create_catalog_router())
app.include_router(create_classification_router(lambda: settings))
app.include_router(create_albums_router())
app.include_router(create_taxonomy_router())
app.include_router(create_animals_router())


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
def update_photo(photo_id: int, metadata: PhotoUpdate, session: SessionDep) -> Photo:
    photo = photo_or_404(photo_id, session)
    updates = metadata.model_dump(exclude_unset=True)
    if not updates:
        return photo

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
    photo.updated_at = utc_now()
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

    return FileResponse(image_path)
