from __future__ import annotations

import warnings
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError
from sqlmodel import Session, select

from app.archive_integrity import ArchiveIntegrityError, inspect_database
from app.config import Settings
from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION
from app.models import Photo
from app.services.image_codecs import open_image
from app.services.photo_lifecycle import stored_image_path
from app.services.photo_metadata import ExtractedPhotoMetadata, extract_photo_metadata

BACKFILL_BATCH_SIZE = 25


class MetadataBackfillSetupError(RuntimeError):
    """The configured archive cannot be safely backfilled."""


@dataclass(frozen=True)
class MetadataBackfillError:
    photo_id: int
    message: str


@dataclass(frozen=True)
class MetadataBackfillResult:
    applied: bool
    processed: int
    updated: int
    skipped: int
    errors: tuple[MetadataBackfillError, ...]


def _updates(
    photo: Photo, metadata: ExtractedPhotoMetadata
) -> dict[str, object | None]:
    values: dict[str, object | None] = {}
    if photo.captured_at is None and metadata.captured_at is not None:
        values["captured_at"] = metadata.captured_at
        values["captured_at_offset_minutes"] = metadata.captured_at_offset_minutes
    for field in ("camera_make", "camera_model", "lens_model"):
        if getattr(photo, field) is None and getattr(metadata, field) is not None:
            values[field] = getattr(metadata, field)
    if photo.image_width is None and photo.image_height is None:
        values["image_width"] = metadata.image_width
        values["image_height"] = metadata.image_height
    if (
        photo.latitude is None
        and photo.longitude is None
        and metadata.latitude is not None
        and metadata.longitude is not None
    ):
        values["latitude"] = metadata.latitude
        values["longitude"] = metadata.longitude
    return values


def backfill_photo_metadata(
    settings: Settings,
    *,
    apply: bool = False,
    batch_size: int = BACKFILL_BATCH_SIZE,
) -> MetadataBackfillResult:
    if settings.database_path is None or not settings.database_path.is_file():
        raise MetadataBackfillSetupError("Configured SQLite database does not exist")
    if batch_size < 1:
        raise MetadataBackfillSetupError("batch_size must be positive")
    try:
        inspect_database(settings.database_path, LATEST_SCHEMA_VERSION)
    except ArchiveIntegrityError as exc:
        raise MetadataBackfillSetupError(str(exc)) from exc
    for directory in (settings.staging_dir, settings.purge_dir):
        if directory.exists() and any(directory.iterdir()):
            raise MetadataBackfillSetupError(
                "Upload staging and purge journals must be empty"
            )

    engine = create_database_engine(settings)
    processed = 0
    updated = 0
    skipped = 0
    errors: list[MetadataBackfillError] = []
    cursor = 0
    try:
        while True:
            with Session(engine) as session:
                photos = list(
                    session.exec(
                        select(Photo)
                        .where(Photo.id > cursor)
                        .order_by(Photo.id)
                        .limit(batch_size)
                    ).all()
                )
                if not photos:
                    break
                for photo in photos:
                    cursor = int(photo.id)
                    processed += 1
                    path = stored_image_path(
                        settings, "original", photo.stored_filename
                    )
                    if path is None or not path.is_file():
                        errors.append(
                            MetadataBackfillError(cursor, "original is missing")
                        )
                        continue
                    try:
                        with warnings.catch_warnings():
                            warnings.simplefilter(
                                "error", Image.DecompressionBombWarning
                            )
                            with open_image(path) as image:
                                if (
                                    image.width * image.height
                                    > settings.max_image_pixels
                                ):
                                    raise ValueError("image dimensions are too large")
                                image.load()
                                metadata = extract_photo_metadata(image)
                    except (
                        Image.DecompressionBombError,
                        Image.DecompressionBombWarning,
                        UnidentifiedImageError,
                        EOFError,
                        OSError,
                        RuntimeError,
                        SyntaxError,
                        ValueError,
                    ) as exc:
                        errors.append(MetadataBackfillError(cursor, str(exc)))
                        continue
                    changes = _updates(photo, metadata)
                    if not changes:
                        skipped += 1
                        continue
                    updated += 1
                    if apply:
                        for field, value in changes.items():
                            setattr(photo, field, value)
                        session.add(photo)
                if apply:
                    session.commit()
    finally:
        engine.dispose()
    return MetadataBackfillResult(
        applied=apply,
        processed=processed,
        updated=updated,
        skipped=skipped,
        errors=tuple(errors),
    )
