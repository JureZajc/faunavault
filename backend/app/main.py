import base64
import logging
import shutil
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import text
from sqlmodel import Session, SQLModel, select

from app.config import BACKEND_DIR, get_settings
from app.db import engine, get_session
from app.migrations import database_path_for_engine, run_migrations
from app.models import Animal, Photo, Taxon, utc_now
from app.routers.classification import create_classification_router
from app.routers.photo_lifecycle import create_photo_lifecycle_router
from app.schemas import (
    AnimalUpdate,
    PhotoUpdate,
    ReconcileRequest,
    TaxonSelection,
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
from app.services.photo_lifecycle import (
    active_photo_or_404,
    reconcile_purge_journal,
)
from app.services.photo_lifecycle import (
    ensure_storage as ensure_lifecycle_storage,
)

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


def normalized_species_group(value: str | None) -> str:
    return " ".join((value or "Unidentified").strip().lower().split())


def legacy_album_key(value: str | None) -> str:
    encoded = (
        base64.urlsafe_b64encode(normalized_species_group(value).encode("utf-8"))
        .decode("ascii")
        .rstrip("=")
    )
    return f"legacy:{encoded}"


def taxon_album_key(taxon_id: int) -> str:
    return f"taxon:{taxon_id}"


def taxon_to_candidate(taxon: Taxon, cached: bool = True) -> dict:
    return {
        "provider": taxon.provider,
        "external_taxon_id": int(taxon.external_taxon_id),
        "scientific_name": taxon.scientific_name,
        "canonical_name": taxon.canonical_name,
        "common_name": taxon.common_name,
        "rank": taxon.taxonomic_rank,
        "kingdom": taxon.kingdom,
        "phylum": taxon.phylum,
        "class": taxon.taxonomic_class,
        "order": taxon.taxonomic_order,
        "family": taxon.family,
        "genus": taxon.genus,
        "species": taxon.species,
        "cached": cached,
    }


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


def assign_taxon(animal: Animal, taxon: Taxon, status: str) -> None:
    animal.taxon_id = taxon.id
    animal.taxonomy_status = status
    animal.taxonomy_note = None
    animal.updated_at = utc_now()


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


def album_records(
    session: Session,
) -> tuple[list[Animal], list[Photo], dict[int, Taxon]]:
    animals = list(session.exec(select(Animal)).all())
    photos = list(session.exec(select(Photo).where(Photo.deleted_at.is_(None))).all())
    taxa = {taxon.id: taxon for taxon in session.exec(select(Taxon)).all() if taxon.id}
    return animals, photos, taxa


def build_album_groups(session: Session) -> list[dict]:
    animals, photos, taxa = album_records(session)
    photos_by_animal: dict[int, list[Photo]] = defaultdict(list)
    for photo in photos:
        if photo.animal_id is not None:
            photos_by_animal[photo.animal_id].append(photo)
    groups: dict[str, dict] = {}
    for animal in animals:
        taxon = taxa.get(animal.taxon_id) if animal.taxon_id else None
        key = (
            taxon_album_key(taxon.id)
            if taxon and taxon.id is not None
            else legacy_album_key(animal.legacy_species_name)
        )
        if key not in groups:
            groups[key] = {
                "album_key": key,
                "verified": taxon is not None,
                "taxon": taxon,
                "legacy_name": animal.legacy_species_name or "Unidentified",
                "animals": [],
                "photos": [],
            }
        groups[key]["animals"].append(animal)
        groups[key]["photos"].extend(photos_by_animal.get(animal.id or -1, []))
    return list(groups.values())


def album_summary(group: dict) -> dict:
    taxon: Taxon | None = group["taxon"]
    photos: list[Photo] = group["photos"]
    newest = max(
        [animal.created_at for animal in group["animals"]]
        + [photo.created_at for photo in photos],
        default=None,
    )
    cover = max(photos, key=lambda photo: photo.created_at, default=None)
    return {
        "album_key": group["album_key"],
        "verified": group["verified"],
        "common_name": taxon.common_name if taxon else None,
        "scientific_name": (taxon.canonical_name if taxon else group["legacy_name"]),
        "rank": taxon.taxonomic_rank if taxon else None,
        "class": taxon.taxonomic_class if taxon else None,
        "order": taxon.taxonomic_order if taxon else None,
        "family": taxon.family if taxon else None,
        "genus": taxon.genus if taxon else None,
        "species": taxon.species if taxon else group["legacy_name"],
        "animal_count": len(group["animals"]),
        "photo_count": len(photos),
        "newest_at": newest,
        "cover_photo_id": cover.id if cover else None,
        "cover_thumbnail_filename": cover.thumbnail_filename if cover else None,
    }


@app.get("/taxonomy/filters")
def taxonomy_filters(session: SessionDep) -> dict:
    groups = build_album_groups(session)
    fields = {
        "classes": "taxonomic_class",
        "orders": "taxonomic_order",
        "families": "family",
        "genera": "genus",
        "species": "species",
    }
    result: dict[str, list[dict]] = {}
    for output_name, field_name in fields.items():
        counts: dict[str, int] = defaultdict(int)
        for group in groups:
            taxon: Taxon | None = group["taxon"]
            value = (
                getattr(taxon, field_name)
                if taxon
                else (group["legacy_name"] if field_name == "species" else None)
            )
            if value:
                counts[value] += len(group["animals"])
        result[output_name] = [
            {"value": value, "count": count}
            for value, count in sorted(counts.items(), key=lambda item: item[0].lower())
        ]
    return result


@app.get("/species-albums")
def list_species_albums(
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
    sort: str = Query(
        default="name", pattern="^(name|newest|animal_count|photo_count)$"
    ),
) -> dict:
    summaries = [album_summary(group) for group in build_album_groups(session)]
    query = q.strip().lower()
    if query:
        summaries = [
            item
            for item in summaries
            if query
            in " ".join(
                str(item.get(field) or "").lower()
                for field in (
                    "common_name",
                    "scientific_name",
                    "class",
                    "order",
                    "family",
                    "genus",
                )
            )
        ]
    filters = {
        "class": taxonomic_class,
        "order": order,
        "family": family,
        "genus": genus,
        "species": species,
    }
    for field, value in filters.items():
        if value:
            summaries = [item for item in summaries if item.get(field) == value]
    if only_with_photos:
        summaries = [item for item in summaries if item["photo_count"] > 0]
    if sort == "name":
        summaries.sort(
            key=lambda item: (
                (item["common_name"] or item["scientific_name"]).lower(),
                item["album_key"],
            )
        )
    elif sort == "newest":
        summaries.sort(key=lambda item: item["newest_at"] or datetime.min, reverse=True)
    else:
        summaries.sort(
            key=lambda item: (item[sort], item["scientific_name"].lower()),
            reverse=True,
        )
    total = len(summaries)
    start = (page - 1) * page_size
    return {
        "items": summaries[start : start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def find_album_group(session: Session, album_key: str) -> dict:
    group = next(
        (
            group
            for group in build_album_groups(session)
            if group["album_key"] == album_key
        ),
        None,
    )
    if group is None:
        raise HTTPException(status_code=404, detail="Species album not found")
    return group


@app.get("/species-albums/{album_key}")
def get_species_album(
    album_key: str,
    session: SessionDep,
    animal_page: int = Query(default=1, ge=1),
    animal_page_size: int = Query(default=50, ge=1, le=100),
    photo_page: int = Query(default=1, ge=1),
    photo_page_size: int = Query(default=24, ge=1, le=100),
) -> dict:
    group = find_album_group(session, album_key)
    summary = album_summary(group)
    animals: list[Animal] = sorted(group["animals"], key=lambda item: item.identifier)
    photos: list[Photo] = sorted(
        group["photos"], key=lambda item: item.created_at, reverse=True
    )
    animal_start = (animal_page - 1) * animal_page_size
    photo_start = (photo_page - 1) * photo_page_size
    return {
        **summary,
        "taxonomy": taxon_to_candidate(group["taxon"]) if group["taxon"] else None,
        "animals": {
            "items": animals[animal_start : animal_start + animal_page_size],
            "total": len(animals),
            "page": animal_page,
            "page_size": animal_page_size,
        },
        "photos": {
            "items": photos[photo_start : photo_start + photo_page_size],
            "total": len(photos),
            "page": photo_page,
            "page_size": photo_page_size,
        },
    }


@app.put("/species-albums/{album_key}/taxon")
def select_album_taxon(
    album_key: str,
    selection: TaxonSelection,
    session: SessionDep,
) -> dict:
    group = find_album_group(session, album_key)
    if group["verified"]:
        raise HTTPException(
            status_code=409, detail="Album already has verified taxonomy"
        )
    taxon = persist_gbif_taxon(session, selection.gbif_key)
    for animal in group["animals"]:
        assign_taxon(animal, taxon, "manually_linked")
        session.add(animal)
    session.commit()
    return {
        "album_key": taxon_album_key(taxon.id or 0),
        "updated_animals": len(group["animals"]),
        "taxon": taxon_to_candidate(taxon),
    }


@app.post("/taxonomy/reconcile")
def reconcile_taxonomy(
    request: ReconcileRequest,
    session: SessionDep,
) -> dict:
    groups = [
        group
        for group in build_album_groups(session)
        if not group["verified"] and group["legacy_name"] != "Unidentified"
    ][: request.limit]
    result = {"processed": 0, "linked": 0, "ambiguous": 0, "unmatched": 0, "failed": 0}
    for group in groups:
        try:
            match = gbif_request(
                "/species/match",
                {
                    "name": group["legacy_name"],
                    "kingdom": "Animalia",
                    "verbose": "true",
                },
            )
        except HTTPException:
            result["failed"] += len(group["animals"])
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
                for animal in group["animals"]:
                    assign_taxon(animal, taxon, "auto_linked")
                    session.add(animal)
                result["linked"] += len(group["animals"])
            except (HTTPException, KeyError, ValueError):
                result["failed"] += len(group["animals"])
                session.rollback()
                continue
        else:
            for animal in group["animals"]:
                animal.taxonomy_status = status
                animal.taxonomy_note = (
                    match.get("note") or "No confident exact GBIF match"
                )
                animal.updated_at = utc_now()
                session.add(animal)
            result[status] += len(group["animals"])
        session.commit()
        result["processed"] += len(group["animals"])
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
