from datetime import datetime, timezone
from io import BytesIO
import logging
import os
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import model_validator
from sqlalchemy import Column, JSON, text
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

from app.ollama_client import (
    AI_FALLBACK_MODEL,
    AI_PRIMARY_MODEL,
    ClassificationResult,
    OllamaClassificationError,
    classify_image,
)

logger = logging.getLogger(__name__)

DATABASE_PATH = BACKEND_DIR / "data" / "faunavault.db"
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"


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
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
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


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage()
    SQLModel.metadata.create_all(engine)
    ensure_photo_metadata_columns()
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

    photo = Photo(
        original_filename=Path(file.filename or "upload").name,
        stored_filename=stored_filename,
        resized_filename=resized_filename,
        thumbnail_filename=thumbnail_filename,
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


@app.get("/images/{image_type}/{filename}")
def get_image(image_type: str, filename: str) -> FileResponse:
    if image_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=404, detail="Image type not found")

    safe_filename = Path(filename).name
    image_path = IMAGE_DIRS[image_type] / safe_filename
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")

    return FileResponse(image_path)
