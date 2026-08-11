from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import shutil
import warnings
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, func, select

from app.config import Settings
from app.models import Animal, Photo, utc_now
from app.schemas import TrashMutationResponse, TrashPage

logger = logging.getLogger(__name__)
UPLOAD_LOCK = asyncio.Lock()
ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
EXPECTED_FORMAT = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP"}
EXPECTED_MEDIA_TYPE = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}
RESIZED_MAX_SIZE = (1600, 1600)
THUMBNAIL_MAX_SIZE = (480, 480)


@dataclass(frozen=True)
class PreparedUpload:
    original_filename: str
    extension: str
    media_type: str
    digest: str
    size: int
    staged_original: Path
    staged_resized: Path
    staged_thumbnail: Path
    stored_filename: str
    resized_filename: str
    thumbnail_filename: str


def ensure_storage(settings: Settings) -> None:
    if settings.database_path is not None:
        settings.database_path.parent.mkdir(parents=True, exist_ok=True)
    for directory in settings.image_dirs.values():
        directory.mkdir(parents=True, exist_ok=True)
    settings.staging_dir.mkdir(parents=True, exist_ok=True)
    settings.purge_dir.mkdir(parents=True, exist_ok=True)


def clean_extension(filename: str) -> str:
    extension = Path(filename).suffix.lower().lstrip(".")
    return "jpeg" if extension == "jpg" else extension


def safe_original_filename(filename: str | None) -> str:
    raw = (filename or "upload").replace("\\", "/")
    return Path(raw).name or "upload"


def stored_image_path(
    settings: Settings, image_type: str, filename: str
) -> Path | None:
    if image_type not in settings.image_dirs:
        return None
    raw_path = Path(filename)
    if not filename or raw_path.name != filename or raw_path.name in {".", ".."}:
        return None
    image_dir = settings.image_dirs[image_type].resolve()
    image_path = (image_dir / raw_path.name).resolve()
    try:
        image_path.relative_to(image_dir)
    except ValueError:
        return None
    return image_path if image_path.parent == image_dir else None


def _save_variant(
    image: Image.Image, path: Path, extension: str, size: tuple[int, int]
) -> None:
    variant = ImageOps.exif_transpose(image).copy()
    variant.thumbnail(size, Image.Resampling.LANCZOS)
    if extension == "jpeg" and variant.mode not in ("RGB", "L"):
        variant = variant.convert("RGB")
    save_kwargs = (
        {"quality": 88, "optimize": True} if extension in {"jpeg", "webp"} else {}
    )
    variant.save(path, format=EXPECTED_FORMAT[extension], **save_kwargs)


def _cleanup(paths: list[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning(
                "Could not remove lifecycle staging file %s", path, exc_info=True
            )


async def prepare_upload(file: UploadFile, settings: Settings) -> PreparedUpload:
    original_filename = safe_original_filename(file.filename)
    extension = clean_extension(original_filename)
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Unsupported image format")

    media_type = (file.content_type or "").lower()
    if media_type != EXPECTED_MEDIA_TYPE[extension]:
        raise HTTPException(
            status_code=415, detail="Image MIME type does not match its filename"
        )

    ensure_storage(settings)
    operation_id = uuid4().hex
    staged_original = settings.staging_dir / f"{operation_id}.upload"
    staged_resized = settings.staging_dir / f"{operation_id}.resized"
    staged_thumbnail = settings.staging_dir / f"{operation_id}.thumb"
    staged_paths = [staged_original, staged_resized, staged_thumbnail]
    digest = hashlib.sha256()
    size = 0
    try:
        with staged_original.open("xb") as destination:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(
                        status_code=413, detail="Uploaded image is too large"
                    )
                digest.update(chunk)
                destination.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(staged_original) as probe:
                    if probe.format != EXPECTED_FORMAT[extension]:
                        raise HTTPException(
                            status_code=415,
                            detail="Image contents do not match the declared format",
                        )
                    width, height = probe.size
                    if width * height > settings.max_image_pixels:
                        raise HTTPException(
                            status_code=413, detail="Image dimensions are too large"
                        )
                    probe.verify()
                with Image.open(staged_original) as image:
                    image.load()
                    _save_variant(image, staged_resized, extension, RESIZED_MAX_SIZE)
                    _save_variant(
                        image, staged_thumbnail, extension, THUMBNAIL_MAX_SIZE
                    )
        except HTTPException:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
            raise HTTPException(
                status_code=413, detail="Image dimensions are too large"
            ) from exc
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise HTTPException(
                status_code=400, detail="Uploaded file is not a valid image"
            ) from exc
    except Exception:
        _cleanup(staged_paths)
        raise

    safe_id = uuid4().hex
    return PreparedUpload(
        original_filename=original_filename,
        extension=extension,
        media_type=media_type,
        digest=digest.hexdigest(),
        size=size,
        staged_original=staged_original,
        staged_resized=staged_resized,
        staged_thumbnail=staged_thumbnail,
        stored_filename=f"{safe_id}.{extension}",
        resized_filename=f"{safe_id}_resized.{extension}",
        thumbnail_filename=f"{safe_id}_thumb.{extension}",
    )


def _duplicate_error(photo: Photo) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "duplicate_photo",
            "message": "This image is already in FaunaVault.",
            "photo_id": photo.id,
            "location": "trash" if photo.deleted_at is not None else "catalog",
        },
    )


async def create_photo_from_upload(
    session: Session,
    file: UploadFile,
    settings: Settings,
) -> Photo:
    prepared = await prepare_upload(file, settings)
    staged = [
        prepared.staged_original,
        prepared.staged_resized,
        prepared.staged_thumbnail,
    ]
    final = [
        settings.image_dirs["original"] / prepared.stored_filename,
        settings.image_dirs["resized"] / prepared.resized_filename,
        settings.image_dirs["thumbs"] / prepared.thumbnail_filename,
    ]
    async with UPLOAD_LOCK:
        duplicate = session.exec(
            select(Photo).where(Photo.content_sha256 == prepared.digest)
        ).first()
        if duplicate is not None:
            _cleanup(staged)
            raise _duplicate_error(duplicate)

        promoted: list[Path] = []
        try:
            for source, destination in zip(staged, final, strict=True):
                source.replace(destination)
                promoted.append(destination)
            animal = Animal(identifier=f"FV-{uuid4().hex[:12].upper()}")
            session.add(animal)
            session.flush()
            photo = Photo(
                original_filename=prepared.original_filename,
                stored_filename=prepared.stored_filename,
                resized_filename=prepared.resized_filename,
                thumbnail_filename=prepared.thumbnail_filename,
                animal_id=animal.id,
                content_sha256=prepared.digest,
                original_size_bytes=prepared.size,
                media_type=prepared.media_type,
            )
            session.add(photo)
            session.commit()
            session.refresh(photo)
            return photo
        except HTTPException:
            session.rollback()
            _cleanup(promoted + staged)
            raise
        except (OSError, SQLAlchemyError) as exc:
            session.rollback()
            _cleanup(promoted + staged)
            logger.exception("Upload failed while committing local photo lifecycle")
            raise HTTPException(
                status_code=500, detail="Could not save the uploaded photo"
            ) from exc


def active_photo_or_404(photo_id: int, session: Session) -> Photo:
    photo = session.get(Photo, photo_id)
    if photo is None or photo.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Photo not found")
    return photo


def trash_photo_or_404(photo_id: int, session: Session) -> Photo:
    photo = session.get(Photo, photo_id)
    if photo is None or photo.deleted_at is None:
        raise HTTPException(status_code=404, detail="Photo not found in Trash")
    return photo


def move_to_trash(photo_id: int, session: Session) -> TrashMutationResponse:
    photo = active_photo_or_404(photo_id, session)
    photo.deleted_at = utc_now()
    photo.updated_at = utc_now()
    session.add(photo)
    session.commit()
    return TrashMutationResponse(status="trashed", photo_id=photo_id)


def list_trash(session: Session, page: int, page_size: int) -> TrashPage:
    total = session.exec(
        select(func.count()).select_from(Photo).where(Photo.deleted_at.is_not(None))
    ).one()
    items = list(
        session.exec(
            select(Photo)
            .where(Photo.deleted_at.is_not(None))
            .order_by(Photo.deleted_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    )
    return TrashPage(items=items, total=total, page=page, page_size=page_size)


def restore_photo(photo_id: int, session: Session) -> TrashMutationResponse:
    photo = trash_photo_or_404(photo_id, session)
    photo.deleted_at = None
    photo.updated_at = utc_now()
    session.add(photo)
    session.commit()
    return TrashMutationResponse(status="restored", photo_id=photo_id)


def _write_manifest(operation_dir: Path, payload: dict) -> None:
    temporary = operation_dir / "manifest.tmp"
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(operation_dir / "manifest.json")


def _restore_staged(settings: Settings, operation_dir: Path, files: list[dict]) -> None:
    for item in reversed(files):
        staged = operation_dir / item["type"] / item["filename"]
        destination = stored_image_path(settings, item["type"], item["filename"])
        if staged.is_file() and destination is not None and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            staged.replace(destination)


def permanently_delete_photo(
    photo_id: int,
    session: Session,
    settings: Settings,
) -> TrashMutationResponse:
    photo = trash_photo_or_404(photo_id, session)
    operation_dir = settings.purge_dir / uuid4().hex
    operation_dir.mkdir(parents=True, exist_ok=False)
    files = [
        {"type": "original", "filename": photo.stored_filename},
        {"type": "resized", "filename": photo.resized_filename},
        {"type": "thumbs", "filename": photo.thumbnail_filename},
    ]
    manifest = {"photo_id": photo_id, "phase": "staging", "files": files}
    _write_manifest(operation_dir, manifest)
    missing = 0
    try:
        for item in files:
            source = stored_image_path(settings, item["type"], item["filename"])
            if source is None or not source.is_file():
                missing += 1
                continue
            destination_dir = operation_dir / item["type"]
            destination_dir.mkdir(exist_ok=True)
            source.replace(destination_dir / item["filename"])
        manifest["phase"] = "staged"
        _write_manifest(operation_dir, manifest)
    except OSError as exc:
        _restore_staged(settings, operation_dir, files)
        shutil.rmtree(operation_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500, detail="Could not stage photo files for deletion"
        ) from exc

    try:
        session.delete(photo)
        session.commit()
    except SQLAlchemyError as exc:
        session.rollback()
        _restore_staged(settings, operation_dir, files)
        shutil.rmtree(operation_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500, detail="Could not permanently delete photo"
        ) from exc

    manifest["phase"] = "committed"
    _write_manifest(operation_dir, manifest)
    try:
        shutil.rmtree(operation_dir)
    except OSError:
        logger.warning(
            "Permanent deletion cleanup will be retried at startup", exc_info=True
        )
    return TrashMutationResponse(
        status="deleted", photo_id=photo_id, missing_files=missing
    )


def reconcile_purge_journal(session: Session, settings: Settings) -> None:
    if not settings.purge_dir.exists():
        return
    for operation_dir in settings.purge_dir.iterdir():
        manifest_path = operation_dir / "manifest.json"
        if not operation_dir.is_dir() or not manifest_path.is_file():
            continue
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            photo_id = int(payload["photo_id"])
            files = payload["files"]
            if session.get(Photo, photo_id) is not None:
                _restore_staged(settings, operation_dir, files)
            shutil.rmtree(operation_dir)
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            logger.warning(
                "Could not reconcile purge operation %s",
                operation_dir.name,
                exc_info=True,
            )
