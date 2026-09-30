from __future__ import annotations

import warnings

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from app.archive_integrity import (
    ArchiveIntegrityError,
    contains_link_or_junction,
    file_identity,
    hash_file_stable,
    validate_flat_filename,
)
from app.config import Settings
from app.models import Photo
from app.services.image_codecs import open_image
from app.services.image_variants import source_format_for_extension
from app.services.photo_lifecycle import stored_image_path
from app.services.photo_metadata import ExtractedPhotoMetadata, extract_photo_metadata

CAPTURE_FIELDS = ("captured_at", "captured_at_offset_minutes", "latitude", "longitude")
PROVENANCE_FIELDS = tuple(f"extracted_{name}" for name in CAPTURE_FIELDS) + (
    "capture_metadata_overridden",
    "location_metadata_overridden",
)


def read_original_capture_metadata(
    photo: Photo, settings: Settings
) -> ExtractedPhotoMetadata:
    """Re-extract supported fields without creating derivatives or changing originals."""
    try:
        validate_flat_filename(photo.stored_filename)
        raw_path = settings.image_dirs["original"] / photo.stored_filename
        # Check before resolving: the serving helper resolves in-directory links.
        if contains_link_or_junction(raw_path):
            raise ValueError("Original path contains a link or junction")
        path = stored_image_path(settings, "original", photo.stored_filename)
        policy = source_format_for_extension(photo.stored_filename)
        if (
            path is None
            or policy is None
            or contains_link_or_junction(path)
            or not path.is_file()
        ):
            raise ValueError("Original is missing or its path is unsafe")
        digest, size, identity = hash_file_stable(path)
        if photo.content_sha256 is not None and digest != photo.content_sha256:
            raise ValueError("Original checksum does not match the archive")
        if photo.original_size_bytes is not None and size != photo.original_size_bytes:
            raise ValueError("Original size does not match the archive")
        if (
            photo.media_type is not None
            and photo.media_type != policy.source.media_type
        ):
            raise ValueError("Original media type does not match the archive")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with open_image(path) as image:
                if image.format != policy.source.pillow_format:
                    raise ValueError("Original format does not match the archive")
                if image.width * image.height > settings.max_image_pixels:
                    raise ValueError("Original exceeds the image pixel limit")
                image.load()
                metadata = extract_photo_metadata(image)
        if contains_link_or_junction(raw_path) or file_identity(raw_path) != identity:
            raise ValueError("Original changed while metadata was being read")
        return metadata
    except (
        ArchiveIntegrityError,
        OSError,
        ValueError,
        RuntimeError,
        EOFError,
        SyntaxError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "original_metadata_unavailable",
                "message": f"Could not restore original metadata: {exc}",
            },
        ) from exc
