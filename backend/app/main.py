import logging
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlmodel import Session, SQLModel, select

from app.album_identity import normalize_legacy_species_group
from app.config import BACKEND_DIR, get_settings
from app.db import engine, get_session
from app.migrations import database_path_for_engine, run_migrations
from app.models import Animal, Photo, Taxon, utc_now
from app.routers.albums import create_albums_router
from app.routers.catalog import create_catalog_router
from app.routers.classification import create_classification_router
from app.routers.photo_lifecycle import create_photo_lifecycle_router
from app.schemas import (
    AnimalUpdate,
    PhotoUpdate,
    ReconcileRequest,
    TaxonSelection,
)
from app.services.albums import (
    list_legacy_reconciliation_groups,
    update_reconciliation_group,
)
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
from app.services.photo_lifecycle import active_photo_or_404, reconcile_purge_journal
from app.services.photo_lifecycle import (
    ensure_storage as ensure_lifecycle_storage,
)
from app.services.taxonomy import assign_taxon, taxon_to_candidate

logger = logging.getLogger(__name__)
settings = get_settings()
DATABASE_PATH = settings.database_path or BACKEND_DIR / "data" / "faunavault.db"
DATABASE_URL = settings.resolved_database_url
IMAGE_ROOT = settings.image_dir
IMAGE_DIRS = settings.image_dirs

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_IMAGE_TYPES = set(IMAGE_DIRS)
RESIZED_MAX_SIZE = (1600, 1600)
THUMBNAIL_MAX_SIZE = (480, 480)


@asynccontextmanager
async def lifespan(application: FastAPI):
    on_startup()
    recover_interrupted_jobs(engine)
    worker = getattr(application.state, "classification_worker", None)
    managed_worker = worker is None
    if worker is None:
        worker = ClassificationWorker(engine, settings)
        application.state.classification_worker = worker
    await worker.start()
    try:
        yield
    finally:
        await worker.stop()
        if managed_worker:
            del application.state.classification_worker


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


def backup_database_before_taxonomy_migration() -> None:
    database_path = database_path_for_engine(engine)
    if database_path is None or not database_path.exists():
        return
    backup_path = database_path.with_suffix(".pre-taxonomy.bak")
    if not backup_path.exists():
        shutil.copy2(database_path, backup_path)


def migrate_animals_and_taxonomy() -> None:
    """Add the nullable photo link and conservatively backfill one animal per photo."""
    with engine.begin() as connection:
        connection.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migration "
                "(version INTEGER PRIMARY KEY, applied_at DATETIME NOT NULL)"
            )
        )
        applied = connection.execute(
            text("SELECT 1 FROM schema_migration WHERE version = 1")
        ).first()
        columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(photo)"))
        }
        if "animal_id" not in columns:
            connection.execute(text("ALTER TABLE photo ADD COLUMN animal_id INTEGER"))
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_photo_animal_id ON photo (animal_id)"
                )
            )
        if applied is None:
            connection.execute(
                text(
                    """
                    INSERT INTO animal (
                        identifier, display_name, taxon_id, legacy_common_name,
                        legacy_species_name, taxonomy_status, taxonomy_note,
                        created_at, updated_at
                    )
                    SELECT
                        printf('FV-P%06d', p.id), NULL, NULL, p.common_name,
                        p.species_guess, 'unreviewed', NULL, p.created_at, p.updated_at
                    FROM photo p
                    WHERE p.animal_id IS NULL
                    """
                )
            )
            animal_columns = {
                row[1] for row in connection.execute(text("PRAGMA table_info(animal)"))
            }
            if "legacy_species_group" in animal_columns:
                rows = connection.execute(
                    text("SELECT id, legacy_species_name FROM animal")
                ).all()
                if rows:
                    connection.execute(
                        text(
                            "UPDATE animal "
                            "SET legacy_species_group = :legacy_species_group "
                            "WHERE id = :animal_id"
                        ),
                        [
                            {
                                "animal_id": animal_id,
                                "legacy_species_group": normalize_legacy_species_group(
                                    legacy_name
                                ),
                            }
                            for animal_id, legacy_name in rows
                        ],
                    )
            connection.execute(
                text(
                    """
                    UPDATE photo
                    SET animal_id = (
                        SELECT a.id FROM animal a
                        WHERE a.identifier = printf('FV-P%06d', photo.id)
                    )
                    WHERE animal_id IS NULL
                    """
                )
            )
            connection.execute(
                text(
                    "INSERT INTO schema_migration(version, applied_at) "
                    "VALUES (1, CURRENT_TIMESTAMP)"
                )
            )


def on_startup() -> None:
    ensure_storage()
    backup_database_before_taxonomy_migration()
    SQLModel.metadata.create_all(
        engine, tables=[Taxon.__table__, Animal.__table__, Photo.__table__]
    )
    migrate_animals_and_taxonomy()
    run_migrations(engine, settings, normalize_existing_domestic_metadata)
    with Session(engine) as session:
        reconcile_purge_journal(session, settings)


SessionDep = Annotated[Session, Depends(get_session)]
app.include_router(create_photo_lifecycle_router(lambda: settings))
app.include_router(create_catalog_router())
app.include_router(create_classification_router(lambda: settings))


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


GBIF_BASE_URL = settings.gbif_base_url.rstrip("/")
GBIF_TIMEOUT = httpx.Timeout(10.0, connect=3.0)
TAXONOMY_CACHE_TTL_SECONDS = 600
_taxonomy_search_cache: dict[str, tuple[float, list[dict]]] = {}


def gbif_request(path: str, params: dict | None = None) -> dict:
    try:
        response = httpx.get(
            f"{GBIF_BASE_URL}{path}",
            params=params,
            timeout=GBIF_TIMEOUT,
            headers={"User-Agent": "FaunaVault/0.1 taxonomy integration"},
        )
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=503,
            detail="GBIF taxonomy service is temporarily unavailable",
        ) from exc


def preferred_vernacular(gbif_key: int) -> str | None:
    try:
        payload = gbif_request(f"/species/{gbif_key}/vernacularNames")
    except HTTPException:
        return None
    names = payload.get("results", [])
    english = next(
        (
            item.get("vernacularName")
            for item in names
            if str(item.get("language", "")).lower() in {"eng", "en"}
            and item.get("vernacularName")
        ),
        None,
    )
    return english or next(
        (item.get("vernacularName") for item in names if item.get("vernacularName")),
        None,
    )


def map_gbif_usage(usage: dict, common_name: str | None = None) -> dict:
    key = usage.get("key") or usage.get("usageKey")
    return {
        "provider": "gbif",
        "external_taxon_id": int(key),
        "scientific_name": usage.get("scientificName") or usage.get("canonicalName"),
        "canonical_name": usage.get("canonicalName") or usage.get("scientificName"),
        "common_name": common_name,
        "rank": str(usage.get("rank", "SPECIES")).upper(),
        "kingdom": usage.get("kingdom"),
        "phylum": usage.get("phylum"),
        "class": usage.get("class"),
        "order": usage.get("order"),
        "family": usage.get("family"),
        "genus": usage.get("genus"),
        "species": usage.get("species") or usage.get("canonicalName"),
        "cached": False,
    }


def persist_gbif_taxon(session: Session, gbif_key: int) -> Taxon:
    existing = session.exec(
        select(Taxon).where(
            Taxon.provider == "gbif",
            Taxon.external_taxon_id == str(gbif_key),
        )
    ).first()
    if existing is not None:
        return existing

    usage = gbif_request(f"/species/{gbif_key}")
    accepted_key = usage.get("acceptedKey")
    if accepted_key and int(accepted_key) != gbif_key:
        usage = gbif_request(f"/species/{accepted_key}")
        gbif_key = int(accepted_key)
        existing = session.exec(
            select(Taxon).where(
                Taxon.provider == "gbif",
                Taxon.external_taxon_id == str(gbif_key),
            )
        ).first()
        if existing is not None:
            return existing

    mapped = map_gbif_usage(usage, preferred_vernacular(gbif_key))
    taxon = Taxon(
        provider="gbif",
        external_taxon_id=str(gbif_key),
        scientific_name=mapped["scientific_name"],
        canonical_name=mapped["canonical_name"],
        common_name=mapped["common_name"],
        taxonomic_rank=mapped["rank"],
        kingdom=mapped["kingdom"],
        phylum=mapped["phylum"],
        taxonomic_class=mapped["class"],
        taxonomic_order=mapped["order"],
        family=mapped["family"],
        genus=mapped["genus"],
        species=mapped["species"],
        synchronized_at=utc_now(),
    )
    session.add(taxon)
    session.flush()
    return taxon


app.include_router(create_albums_router(persist_gbif_taxon))


@app.get("/taxonomy/search")
def search_taxonomy(
    session: SessionDep,
    q: str = Query(min_length=2, max_length=120),
    limit: int = Query(default=12, ge=1, le=30),
) -> dict:
    query = q.strip()
    local_taxa = list(
        session.exec(
            select(Taxon)
            .where(
                (Taxon.scientific_name.contains(query))
                | (Taxon.canonical_name.contains(query))
                | (Taxon.common_name.contains(query))
            )
            .limit(limit)
        ).all()
    )
    local_results = [taxon_to_candidate(taxon) for taxon in local_taxa]
    cache_key = f"{query.lower()}:{limit}"
    cached = _taxonomy_search_cache.get(cache_key)
    if cached and time.monotonic() - cached[0] < TAXONOMY_CACHE_TTL_SECONDS:
        return {
            "results": local_results + cached[1],
            "external_available": True,
            "warning": None,
        }

    try:
        payload = gbif_request(
            "/species/search",
            {"q": query, "limit": limit * 2, "status": "ACCEPTED"},
        )
        remote_results: list[dict] = []
        local_keys = {result["external_taxon_id"] for result in local_results}
        for usage in payload.get("results", []):
            if str(usage.get("kingdom", "")).lower() != "animalia":
                continue
            if str(usage.get("rank", "")).upper() not in {"SPECIES", "SUBSPECIES"}:
                continue
            vernacular = next(iter(usage.get("vernacularNames", []) or []), None)
            if isinstance(vernacular, dict):
                vernacular = vernacular.get("vernacularName")
            candidate = map_gbif_usage(
                usage,
                vernacular if isinstance(vernacular, str) else None,
            )
            if candidate["external_taxon_id"] not in local_keys:
                remote_results.append(candidate)
            if len(remote_results) >= limit:
                break
        _taxonomy_search_cache[cache_key] = (time.monotonic(), remote_results)
        return {
            "results": local_results + remote_results,
            "external_available": True,
            "warning": None,
        }
    except HTTPException:
        if not local_results:
            raise
        return {
            "results": local_results,
            "external_available": False,
            "warning": "GBIF is unavailable; showing locally cached taxa.",
        }


def animal_or_404(animal_id: int, session: Session) -> Animal:
    animal = session.get(Animal, animal_id)
    if animal is None:
        raise HTTPException(status_code=404, detail="Animal not found")
    return animal


@app.get("/animals/{animal_id}", response_model=Animal)
def get_animal(animal_id: int, session: SessionDep) -> Animal:
    return animal_or_404(animal_id, session)


@app.patch("/animals/{animal_id}", response_model=Animal)
def update_animal(
    animal_id: int,
    update: AnimalUpdate,
    session: SessionDep,
) -> Animal:
    animal = animal_or_404(animal_id, session)
    if "display_name" not in update.model_fields_set:
        return animal

    animal.display_name = update.display_name
    animal.updated_at = utc_now()
    session.add(animal)
    session.commit()
    session.refresh(animal)
    return animal


@app.put("/animals/{animal_id}/taxon")
def select_animal_taxon(
    animal_id: int,
    selection: TaxonSelection,
    session: SessionDep,
) -> dict:
    animal = animal_or_404(animal_id, session)
    taxon = persist_gbif_taxon(session, selection.gbif_key)
    assign_taxon(animal, taxon, "manually_linked")
    session.add(animal)
    session.commit()
    session.refresh(animal)
    return {"animal": animal, "taxon": taxon_to_candidate(taxon)}


@app.post("/taxonomy/reconcile")
def reconcile_taxonomy(
    request: ReconcileRequest,
    session: SessionDep,
) -> dict:
    groups = list_legacy_reconciliation_groups(session, request.limit)
    result = {"processed": 0, "linked": 0, "ambiguous": 0, "unmatched": 0, "failed": 0}
    for group in groups:
        try:
            match = gbif_request(
                "/species/match",
                {
                    "name": group.legacy_name,
                    "kingdom": "Animalia",
                    "verbose": "true",
                },
            )
        except HTTPException:
            result["failed"] += group.animal_count
            continue
        note = str(match.get("note", "")).lower()
        accepted = (
            match.get("matchType") == "EXACT"
            and match.get("confidence") == 100
            and str(match.get("rank", "")).upper() in {"SPECIES", "SUBSPECIES"}
            and str(match.get("kingdom", "")).lower() == "animalia"
            and "multiple" not in note
            and (match.get("usageKey") or match.get("acceptedUsageKey"))
        )
        status = "ambiguous" if match.get("matchType") != "NONE" else "unmatched"
        if accepted:
            try:
                key = int(match.get("acceptedUsageKey") or match["usageKey"])
                taxon = persist_gbif_taxon(session, key)
                updated = update_reconciliation_group(
                    session,
                    group,
                    taxon=taxon,
                    status="auto_linked",
                )
                result["linked"] += updated
            except (HTTPException, KeyError, ValueError):
                result["failed"] += group.animal_count
                session.rollback()
                continue
        else:
            updated = update_reconciliation_group(
                session,
                group,
                status=status,
                note=match.get("note") or "No confident exact GBIF match",
            )
            result[status] += updated
        session.commit()
        result["processed"] += updated
    return result


@app.get("/images/{image_type}/{filename}")
def get_image(image_type: str, filename: str) -> FileResponse:
    if image_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=404, detail="Image type not found")

    safe_filename = Path(filename).name
    image_path = IMAGE_DIRS[image_type] / safe_filename
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(image_path)
