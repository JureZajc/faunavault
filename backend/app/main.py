import base64
from collections import defaultdict
from datetime import datetime, timezone
from io import BytesIO
import logging
import os
from pathlib import Path
import shutil
import time
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import ConfigDict, field_validator, model_validator
import httpx
from sqlalchemy import Column, JSON, UniqueConstraint, text
from sqlmodel import Field, Session, SQLModel, create_engine, select

BACKEND_DIR = Path(__file__).resolve().parents[1]


def load_backend_env(env_path: Path) -> None:
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue

        os.environ.setdefault(key, value.strip().strip("\"'"))


load_backend_env(BACKEND_DIR / ".env")

from app.ollama_client import (  # noqa: E402
    AI_FALLBACK_MODEL,
    AI_PRIMARY_MODEL,
    ClassificationResult,
    OllamaClassificationError,
    classify_image,
)

logger = logging.getLogger(__name__)

DATABASE_PATH = BACKEND_DIR / "data" / "faunavault.db"
DATABASE_URL = os.getenv("DATABASE_URL", f"sqlite:///{DATABASE_PATH}")


def default_image_root() -> Path:
    if os.name == "nt":
        return Path("E:/FaunaVault/data/images")
    return Path("/mnt/e/FaunaVault/data/images")


IMAGE_ROOT = Path(os.getenv("IMAGE_DIR", str(default_image_root()))).expanduser()
IMAGE_DIRS = {
    "original": IMAGE_ROOT / "original",
    "resized": IMAGE_ROOT / "resized",
    "thumbs": IMAGE_ROOT / "thumbs",
}

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_IMAGE_TYPES = set(IMAGE_DIRS)
ALLOWED_PHOTO_STATUSES = {"pending", "classified", "needs_review"}
RESIZED_MAX_SIZE = (1600, 1600)
THUMBNAIL_MAX_SIZE = (480, 480)
DOMESTIC_SPECIES_BY_COMMON_NAME = {
    "dog": "Canis lupus familiaris",
    "cat": "Felis catus",
    "horse": "Equus ferus caballus",
    "cow": "Bos taurus",
    "cattle": "Bos taurus",
}
DOG_BREED_GUESSES = {
    "beagle",
    "bernese mountain dog",
    "border collie",
    "boxer",
    "bulldog",
    "chihuahua",
    "cocker spaniel",
    "dachshund",
    "doberman pinscher",
    "french bulldog",
    "german shepherd",
    "golden retriever",
    "great dane",
    "labrador retriever",
    "poodle",
    "pug",
    "rottweiler",
    "shiba inu",
    "siberian husky",
    "yorkshire terrier",
}


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def confidence_threshold() -> float:
    try:
        return float(os.getenv("AI_CONFIDENCE_THRESHOLD", "0.65"))
    except ValueError:
        return 0.65


class Taxon(SQLModel, table=True):
    __table_args__ = (
        UniqueConstraint("provider", "external_taxon_id", name="uq_taxon_provider_id"),
    )

    id: int | None = Field(default=None, primary_key=True)
    provider: str = Field(default="gbif", index=True)
    external_taxon_id: str = Field(index=True)
    scientific_name: str
    canonical_name: str
    common_name: str | None = None
    taxonomic_rank: str
    kingdom: str | None = Field(default=None, index=True)
    phylum: str | None = None
    taxonomic_class: str | None = Field(default=None, index=True)
    taxonomic_order: str | None = Field(default=None, index=True)
    family: str | None = Field(default=None, index=True)
    genus: str | None = Field(default=None, index=True)
    species: str | None = Field(default=None, index=True)
    synchronized_at: datetime = Field(default_factory=utc_now)


class Animal(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    identifier: str = Field(index=True, unique=True)
    display_name: str | None = None
    taxon_id: int | None = Field(default=None, foreign_key="taxon.id", index=True)
    legacy_common_name: str | None = None
    legacy_species_name: str | None = Field(default=None, index=True)
    taxonomy_status: str = Field(default="unreviewed", index=True)
    taxonomy_note: str | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class AnimalUpdate(SQLModel):
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, max_length=100)

    @field_validator("display_name", mode="before")
    @classmethod
    def normalize_display_name(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        normalized = value.strip()
        return normalized or None


class Photo(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    original_filename: str
    stored_filename: str
    resized_filename: str
    thumbnail_filename: str
    display_title: str | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    category: str | None = None
    confidence: float | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = "pending"
    animal_id: int | None = Field(default=None, foreign_key="animal.id", index=True)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class PhotoUpdate(SQLModel):
    display_title: str | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    category: str | None = None
    confidence: float | None = None
    description: str | None = None
    tags: list[str] | None = None
    status: str | None = None

    @model_validator(mode="after")
    def validate_metadata(self) -> "PhotoUpdate":
        if self.confidence is not None and not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be null or between 0 and 1")

        if "status" in self.model_fields_set and self.status not in ALLOWED_PHOTO_STATUSES:
            allowed_statuses = ", ".join(sorted(ALLOWED_PHOTO_STATUSES))
            raise ValueError(f"status must be one of: {allowed_statuses}")

        return self


class TaxonSelection(SQLModel):
    gbif_key: int


class ReconcileRequest(SQLModel):
    limit: int = Field(default=50, ge=1, le=100)


class BatchUploadFailure(SQLModel):
    filename: str
    error: str


class BatchUploadResponse(SQLModel):
    uploaded: list[Photo]
    failed: list[BatchUploadFailure]


class ClassifyPendingRequest(SQLModel):
    limit: int | None = None
    photo_ids: list[int] | None = None

    @model_validator(mode="after")
    def validate_request(self) -> "ClassifyPendingRequest":
        if self.limit is not None and self.limit < 1:
            raise ValueError("limit must be greater than 0")

        if self.photo_ids is not None:
            invalid_ids = [photo_id for photo_id in self.photo_ids if photo_id < 1]
            if invalid_ids:
                raise ValueError("photo_ids must contain positive IDs")

        return self


class ClassifyPendingPhotoResult(SQLModel):
    id: int
    status: str
    display_title: str | None = None
    common_name: str | None = None
    breed_guess: str | None = None
    species_guess: str | None = None
    error: str | None = None


class ClassifyPendingResponse(SQLModel):
    total_found: int
    classified: int
    needs_review: int
    failed: int
    results: list[ClassifyPendingPhotoResult]


engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

app = FastAPI(title="FaunaVault API")
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
    DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    for directory in IMAGE_DIRS.values():
        directory.mkdir(parents=True, exist_ok=True)


def ensure_photo_metadata_columns() -> None:
    with engine.begin() as connection:
        columns = {
            row[1] for row in connection.execute(text("PRAGMA table_info(photo)"))
        }
        for column_name in ("display_title", "breed_guess"):
            if column_name not in columns:
                connection.execute(text(f"ALTER TABLE photo ADD COLUMN {column_name} TEXT"))


def backup_database_before_taxonomy_migration() -> None:
    if not DATABASE_PATH.exists():
        return
    backup_path = DATABASE_PATH.with_suffix(".pre-taxonomy.bak")
    if not backup_path.exists():
        shutil.copy2(DATABASE_PATH, backup_path)


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
                text("CREATE INDEX IF NOT EXISTS ix_photo_animal_id ON photo (animal_id)")
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


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage()
    backup_database_before_taxonomy_migration()
    SQLModel.metadata.create_all(engine)
    ensure_photo_metadata_columns()
    migrate_animals_and_taxonomy()
    normalize_existing_domestic_metadata()


def get_session():
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]


def clean_extension(filename: str) -> str:
    extension = Path(filename).suffix.lower().lstrip(".")
    if extension == "jpg":
        return "jpeg"
    return extension


def output_format(extension: str) -> str:
    return "JPEG" if extension in {"jpg", "jpeg"} else extension.upper()


def save_variant(image: Image.Image, path: Path, extension: str, size: tuple[int, int]) -> None:
    variant = ImageOps.exif_transpose(image).copy()
    variant.thumbnail(size, Image.Resampling.LANCZOS)
    if extension in {"jpg", "jpeg"} and variant.mode not in ("RGB", "L"):
        variant = variant.convert("RGB")
    save_kwargs = {"quality": 88, "optimize": True} if extension in {"jpg", "jpeg", "webp"} else {}
    variant.save(path, format=output_format(extension), **save_kwargs)


def remove_partial_files(paths: tuple[Path, ...]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Failed to remove partial image file: %s", path, exc_info=True)


def stored_image_path(image_type: str, filename: str) -> Path | None:
    raw_path = Path(filename)
    if not filename or raw_path.name != filename or raw_path.name in {".", ".."}:
        logger.warning("Skipped unsafe image filename for deletion: %s", filename)
        return None

    image_dir = IMAGE_DIRS[image_type].resolve()
    image_path = (image_dir / raw_path.name).resolve()
    try:
        image_path.relative_to(image_dir)
    except ValueError:
        logger.warning("Skipped image path outside storage directory: %s", image_path)
        return None

    if image_path.parent != image_dir:
        logger.warning("Skipped nested image path outside flat storage directory: %s", image_path)
        return None

    return image_path


def delete_photo_file(image_type: str, filename: str) -> bool:
    image_path = stored_image_path(image_type, filename)
    if image_path is None or not image_path.exists():
        return False

    if not image_path.is_file():
        logger.warning("Skipped non-file image path during deletion: %s", image_path)
        return False

    image_path.unlink()
    return True


def photo_or_404(photo_id: int, session: Session) -> Photo:
    photo = session.get(Photo, photo_id)
    if photo is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    return photo


def normalize_tags(tags: list[str] | None) -> list[str]:
    if tags is None:
        return []

    return [tag.strip() for tag in tags if tag.strip()]


def normalize_metadata_text(value: str | None) -> str | None:
    if value is None:
        return None

    stripped_value = value.strip()
    return stripped_value or None


def normalized_lookup(value: str | None) -> str:
    normalized_value = normalize_metadata_text(value)
    return normalized_value.lower() if normalized_value is not None else ""


def canonical_common_name(value: str | None) -> str | None:
    lookup_value = normalized_lookup(value)
    if lookup_value in {"dog", "domestic dog", "canine"}:
        return "dog"
    if lookup_value in {"cat", "domestic cat", "feline"}:
        return "cat"
    if lookup_value in {"horse", "domestic horse"}:
        return "horse"
    if lookup_value in {"cow", "cattle", "domestic cow", "domestic cattle"}:
        return "cow"
    return normalize_metadata_text(value)


def is_dog_breed_guess(value: str | None) -> bool:
    return normalized_lookup(value) in DOG_BREED_GUESSES


def is_expected_species(value: str | None, expected_species: str) -> bool:
    return normalized_lookup(value) == expected_species.lower()


def apply_domestic_metadata_normalization(photo: Photo) -> None:
    common_name = canonical_common_name(photo.common_name)
    species_guess = normalize_metadata_text(photo.species_guess)
    breed_guess = normalize_metadata_text(photo.breed_guess)
    display_title = normalize_metadata_text(photo.display_title)

    photo.common_name = common_name
    photo.species_guess = species_guess
    photo.breed_guess = breed_guess
    photo.display_title = display_title

    if common_name is None:
        return

    common_lookup = normalized_lookup(common_name)
    expected_species = DOMESTIC_SPECIES_BY_COMMON_NAME.get(common_lookup)
    if expected_species is None:
        return

    if common_lookup == "dog" and species_guess and not is_expected_species(
        species_guess,
        expected_species,
    ):
        if is_dog_breed_guess(species_guess):
            photo.breed_guess = breed_guess or species_guess
            photo.display_title = display_title or species_guess

    if common_lookup == "horse" and species_guess and not is_expected_species(
        species_guess,
        expected_species,
    ):
        photo.breed_guess = breed_guess or species_guess
        photo.display_title = display_title or species_guess

    photo.species_guess = expected_species
    photo.category = "mammal"


def normalize_existing_domestic_metadata() -> None:
    with Session(engine) as session:
        photos = list(session.exec(select(Photo)).all())
        has_changes = False

        for photo in photos:
            original_metadata = (
                photo.display_title,
                photo.common_name,
                photo.breed_guess,
                photo.species_guess,
                photo.category,
            )
            apply_domestic_metadata_normalization(photo)
            next_metadata = (
                photo.display_title,
                photo.common_name,
                photo.breed_guess,
                photo.species_guess,
                photo.category,
            )

            if next_metadata != original_metadata:
                photo.updated_at = utc_now()
                session.add(photo)
                has_changes = True

        if has_changes:
            session.commit()


def classification_image_path(photo: Photo) -> Path:
    resized_path = IMAGE_DIRS["resized"] / Path(photo.resized_filename).name
    if resized_path.exists() and resized_path.is_file():
        return resized_path

    original_path = IMAGE_DIRS["original"] / Path(photo.stored_filename).name
    if original_path.exists() and original_path.is_file():
        return original_path

    raise HTTPException(status_code=404, detail="No image file found for classification")


def classify_with_fallback(image_path: Path, threshold: float) -> ClassificationResult:
    primary_result: ClassificationResult | None = None
    errors: list[str] = []

    try:
        primary_result = classify_image(image_path, AI_PRIMARY_MODEL)
    except OllamaClassificationError as exc:
        errors.append(str(exc))

    should_try_fallback = primary_result is None or primary_result.confidence < threshold
    if should_try_fallback and AI_FALLBACK_MODEL != AI_PRIMARY_MODEL:
        try:
            return classify_image(image_path, AI_FALLBACK_MODEL)
        except OllamaClassificationError as exc:
            errors.append(str(exc))

    if primary_result is not None:
        return primary_result

    detail = "; ".join(errors) if errors else "Local AI classification failed"
    raise HTTPException(status_code=502, detail=detail)


def apply_classification(photo: Photo, result: ClassificationResult, threshold: float) -> None:
    photo.display_title = result.display_title
    photo.common_name = result.common_name
    photo.breed_guess = result.breed_guess
    photo.species_guess = result.species_guess
    photo.category = result.category
    photo.confidence = result.confidence
    photo.description = result.description
    photo.tags = result.tags
    apply_domestic_metadata_normalization(photo)
    photo.status = (
        "classified"
        if result.is_animal and not result.needs_review and result.confidence >= threshold
        else "needs_review"
    )
    photo.updated_at = utc_now()


async def create_photo_from_upload(session: Session, file: UploadFile) -> Photo:
    extension = clean_extension(file.filename or "")
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported image format")

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    try:
        image = Image.open(BytesIO(contents))
        image.load()
    except UnidentifiedImageError as exc:
        raise HTTPException(status_code=400, detail="Uploaded file is not a valid image") from exc

    safe_id = uuid4().hex
    stored_filename = f"{safe_id}.{extension}"
    resized_filename = f"{safe_id}_resized.{extension}"
    thumbnail_filename = f"{safe_id}_thumb.{extension}"

    original_path = IMAGE_DIRS["original"] / stored_filename
    resized_path = IMAGE_DIRS["resized"] / resized_filename
    thumbnail_path = IMAGE_DIRS["thumbs"] / thumbnail_filename

    ensure_storage()
    try:
        original_path.write_bytes(contents)
    except OSError as exc:
        logger.exception("Failed to store original image at %s", original_path)
        raise HTTPException(
            status_code=500,
            detail="Failed to store original image file",
        ) from exc

    try:
        save_variant(image, resized_path, extension, RESIZED_MAX_SIZE)
        save_variant(image, thumbnail_path, extension, THUMBNAIL_MAX_SIZE)
    except Exception as exc:
        logger.exception(
            "Failed to process uploaded image variants with Pillow: resized=%s thumbnail=%s",
            resized_path,
            thumbnail_path,
        )
        remove_partial_files((original_path, resized_path, thumbnail_path))
        raise HTTPException(
            status_code=400,
            detail="Uploaded image could not be processed",
        ) from exc

    animal = Animal(identifier=f"FV-{uuid4().hex[:12].upper()}")
    session.add(animal)
    session.flush()
    photo = Photo(
        original_filename=Path(file.filename or "upload").name,
        stored_filename=stored_filename,
        resized_filename=resized_filename,
        thumbnail_filename=thumbnail_filename,
        animal_id=animal.id,
    )
    session.add(photo)
    session.commit()
    session.refresh(photo)
    return photo


def upload_error_detail(error: HTTPException) -> str:
    return str(error.detail) if error.detail else "Upload failed"


def snapshot_photo(photo: Photo) -> Photo:
    return Photo(**photo.model_dump())


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/photos/upload", response_model=Photo)
async def upload_photo(session: SessionDep, file: UploadFile = File(...)) -> Photo:
    return await create_photo_from_upload(session, file)


@app.post("/photos/upload-batch", response_model=BatchUploadResponse)
async def upload_photo_batch(
    session: SessionDep,
    files: list[UploadFile] = File(...),
) -> BatchUploadResponse:
    uploaded: list[Photo] = []
    failed: list[BatchUploadFailure] = []

    for file in files:
        filename = Path(file.filename or "upload").name
        try:
            photo = await create_photo_from_upload(session, file)
            uploaded.append(snapshot_photo(photo))
        except HTTPException as exc:
            failed.append(
                BatchUploadFailure(filename=filename, error=upload_error_detail(exc))
            )
        except Exception:
            logger.exception("Unexpected failure during batch upload for %s", filename)
            failed.append(BatchUploadFailure(filename=filename, error="Upload failed"))

    return BatchUploadResponse(uploaded=uploaded, failed=failed)


@app.get("/photos", response_model=list[Photo])
def list_photos(session: SessionDep) -> list[Photo]:
    statement = select(Photo).order_by(Photo.created_at.desc())
    return list(session.exec(statement).all())


@app.post("/photos/classify-pending", response_model=ClassifyPendingResponse)
def classify_pending_photos(
    session: SessionDep,
    request: ClassifyPendingRequest | None = None,
) -> ClassifyPendingResponse:
    request = request or ClassifyPendingRequest()
    statement = (
        select(Photo)
        .where(Photo.status == "pending")
        .order_by(Photo.created_at.asc())
    )

    if request.photo_ids is not None:
        statement = statement.where(Photo.id.in_(request.photo_ids))

    if request.limit is not None:
        statement = statement.limit(request.limit)

    pending_photos = list(session.exec(statement).all())
    threshold = confidence_threshold()
    results: list[ClassifyPendingPhotoResult] = []
    classified = 0
    needs_review = 0
    failed = 0

    for photo in pending_photos:
        photo_id = photo.id
        if photo_id is None:
            continue

        try:
            image_path = classification_image_path(photo)
            classification = classify_with_fallback(image_path, threshold)
            apply_classification(photo, classification, threshold)
            session.add(photo)
            session.commit()
            session.refresh(photo)

            if photo.status == "classified":
                classified += 1
            elif photo.status == "needs_review":
                needs_review += 1

            results.append(
                ClassifyPendingPhotoResult(
                    id=photo_id,
                    status=photo.status,
                    display_title=photo.display_title,
                    common_name=photo.common_name,
                    breed_guess=photo.breed_guess,
                    species_guess=photo.species_guess,
                )
            )
        except HTTPException as exc:
            session.rollback()
            failed += 1
            results.append(
                ClassifyPendingPhotoResult(
                    id=photo_id,
                    status="failed",
                    error=str(exc.detail) if exc.detail else "Classification failed",
                )
            )
        except Exception:
            session.rollback()
            logger.exception(
                "Unexpected failure during pending classification for photo %s",
                photo_id,
            )
            failed += 1
            results.append(
                ClassifyPendingPhotoResult(
                    id=photo_id,
                    status="failed",
                    error="Classification failed",
                )
            )

    return ClassifyPendingResponse(
        total_found=len(pending_photos),
        classified=classified,
        needs_review=needs_review,
        failed=failed,
        results=results,
    )


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


@app.delete("/photos/{photo_id}")
def delete_photo(photo_id: int, session: SessionDep) -> dict[str, int | str]:
    photo = photo_or_404(photo_id, session)
    image_files = (
        ("original", photo.stored_filename),
        ("resized", photo.resized_filename),
        ("thumbs", photo.thumbnail_filename),
    )

    try:
        for image_type, filename in image_files:
            delete_photo_file(image_type, filename)
    except OSError as exc:
        logger.exception("Failed to delete image file for photo %s", photo_id)
        raise HTTPException(
            status_code=500,
            detail="Failed to delete one or more image files",
        ) from exc

    session.delete(photo)
    session.commit()
    return {"status": "deleted", "photo_id": photo_id}


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


@app.post("/photos/{photo_id}/classify", response_model=Photo)
def classify_photo(photo_id: int, session: SessionDep) -> Photo:
    photo = photo_or_404(photo_id, session)
    threshold = confidence_threshold()
    image_path = classification_image_path(photo)
    result = classify_with_fallback(image_path, threshold)

    apply_classification(photo, result, threshold)
    session.add(photo)
    session.commit()
    session.refresh(photo)
    return photo


GBIF_BASE_URL = os.getenv("GBIF_BASE_URL", "https://api.gbif.org/v1").rstrip("/")
GBIF_TIMEOUT = httpx.Timeout(10.0, connect=3.0)
TAXONOMY_CACHE_TTL_SECONDS = 600
_taxonomy_search_cache: dict[str, tuple[float, list[dict]]] = {}


def normalized_species_group(value: str | None) -> str:
    return " ".join((value or "Unidentified").strip().lower().split())


def legacy_album_key(value: str | None) -> str:
    encoded = base64.urlsafe_b64encode(
        normalized_species_group(value).encode("utf-8")
    ).decode("ascii").rstrip("=")
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
        "canonical_name": usage.get("canonicalName")
        or usage.get("scientificName"),
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
            select(Taxon).where(
                (Taxon.scientific_name.contains(query))
                | (Taxon.canonical_name.contains(query))
                | (Taxon.common_name.contains(query))
            ).limit(limit)
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


def album_records(session: Session) -> tuple[list[Animal], list[Photo], dict[int, Taxon]]:
    animals = list(session.exec(select(Animal)).all())
    photos = list(session.exec(select(Photo)).all())
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
        "scientific_name": (
            taxon.canonical_name if taxon else group["legacy_name"]
        ),
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
            value = getattr(taxon, field_name) if taxon else (
                group["legacy_name"] if field_name == "species" else None
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
    sort: str = Query(default="name", pattern="^(name|newest|animal_count|photo_count)$"),
) -> dict:
    summaries = [album_summary(group) for group in build_album_groups(session)]
    query = q.strip().lower()
    if query:
        summaries = [
            item for item in summaries
            if query in " ".join(
                str(item.get(field) or "").lower()
                for field in ("common_name", "scientific_name", "class", "order", "family", "genus")
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
        summaries.sort(key=lambda item: (
            (item["common_name"] or item["scientific_name"]).lower(),
            item["album_key"],
        ))
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
        "items": summaries[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


def find_album_group(session: Session, album_key: str) -> dict:
    group = next(
        (group for group in build_album_groups(session) if group["album_key"] == album_key),
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
            "items": animals[animal_start:animal_start + animal_page_size],
            "total": len(animals),
            "page": animal_page,
            "page_size": animal_page_size,
        },
        "photos": {
            "items": photos[photo_start:photo_start + photo_page_size],
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
        raise HTTPException(status_code=409, detail="Album already has verified taxonomy")
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
        group for group in build_album_groups(session)
        if not group["verified"] and group["legacy_name"] != "Unidentified"
    ][:request.limit]
    result = {"processed": 0, "linked": 0, "ambiguous": 0, "unmatched": 0, "failed": 0}
    for group in groups:
        try:
            match = gbif_request(
                "/species/match",
                {"name": group["legacy_name"], "kingdom": "Animalia", "verbose": "true"},
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
                animal.taxonomy_note = match.get("note") or "No confident exact GBIF match"
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
