from datetime import datetime, timezone
from io import BytesIO
import os
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import Column, JSON
from sqlmodel import Field, Session, SQLModel, create_engine, select

from app.ollama_client import (
    AI_FALLBACK_MODEL,
    AI_PRIMARY_MODEL,
    ClassificationResult,
    OllamaClassificationError,
    classify_image,
)

BACKEND_DIR = Path(__file__).resolve().parents[1]
DATABASE_PATH = BACKEND_DIR / "data" / "faunavault.db"
DATABASE_URL = f"sqlite:///{DATABASE_PATH}"

IMAGE_ROOT = Path("/mnt/e/FaunaVault/data/images")
IMAGE_DIRS = {
    "original": IMAGE_ROOT / "original",
    "resized": IMAGE_ROOT / "resized",
    "thumbs": IMAGE_ROOT / "thumbs",
}

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
ALLOWED_IMAGE_TYPES = set(IMAGE_DIRS)
RESIZED_MAX_SIZE = (1600, 1600)
THUMBNAIL_MAX_SIZE = (480, 480)


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
    common_name: str | None = None
    species_guess: str | None = None
    category: str | None = None
    confidence: float | None = None
    description: str | None = None
    tags: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    status: str = "pending"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


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


@app.on_event("startup")
def on_startup() -> None:
    ensure_storage()
    SQLModel.metadata.create_all(engine)


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


def photo_or_404(photo_id: int, session: Session) -> Photo:
    photo = session.get(Photo, photo_id)
    if photo is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    return photo


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
    photo.common_name = result.common_name
    photo.species_guess = result.species_guess
    photo.category = result.category
    photo.confidence = result.confidence
    photo.description = result.description
    photo.tags = result.tags
    photo.status = (
        "classified"
        if result.is_animal and not result.needs_review and result.confidence >= threshold
        else "needs_review"
    )
    photo.updated_at = utc_now()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/photos/upload", response_model=Photo)
async def upload_photo(session: SessionDep, file: UploadFile = File(...)) -> Photo:
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

    original_path.write_bytes(contents)
    save_variant(image, resized_path, extension, RESIZED_MAX_SIZE)
    save_variant(image, thumbnail_path, extension, THUMBNAIL_MAX_SIZE)

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


@app.get("/photos", response_model=list[Photo])
def list_photos(session: SessionDep) -> list[Photo]:
    statement = select(Photo).order_by(Photo.created_at.desc())
    return list(session.exec(statement).all())


@app.get("/photos/{photo_id}", response_model=Photo)
def get_photo(photo_id: int, session: SessionDep) -> Photo:
    return photo_or_404(photo_id, session)


@app.post("/photos/{photo_id}/mock-classify", response_model=Photo)
def mock_classify_photo(photo_id: int, session: SessionDep) -> Photo:
    photo = photo_or_404(photo_id, session)
    photo.common_name = "Domestic cat"
    photo.species_guess = "Felis catus"
    photo.category = "mammal"
    photo.confidence = 0.88
    photo.description = "A small domestic cat visible in the uploaded photo."
    photo.tags = ["cat", "pet", "mammal"]
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
