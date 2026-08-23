from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageOps

RESIZED_MAX_SIZE = (1600, 1600)
THUMBNAIL_MAX_SIZE = (480, 480)


@dataclass(frozen=True)
class ImageEncoding:
    extension: str
    pillow_format: str
    media_type: str


@dataclass(frozen=True)
class SourceFormatPolicy:
    source: ImageEncoding
    accepted_media_types: frozenset[str]
    derivative: ImageEncoding


JPEG = ImageEncoding("jpeg", "JPEG", "image/jpeg")
PNG = ImageEncoding("png", "PNG", "image/png")
WEBP = ImageEncoding("webp", "WEBP", "image/webp")
HEIC = ImageEncoding("heic", "HEIF", "image/heic")
HEIF = ImageEncoding("heif", "HEIF", "image/heif")

SOURCE_FORMATS = {
    encoding.extension: SourceFormatPolicy(
        source=encoding,
        accepted_media_types=frozenset({encoding.media_type}),
        derivative=derivative,
    )
    for encoding, derivative in (
        (JPEG, JPEG),
        (PNG, PNG),
        (WEBP, WEBP),
        (HEIC, JPEG),
        (HEIF, JPEG),
    )
}


def extension_for_filename(filename: str) -> str:
    return Path(filename).suffix.lower().lstrip(".")


def normalized_extension(filename_or_extension: str) -> str:
    value = filename_or_extension.lower().lstrip(".")
    if "." in value:
        value = extension_for_filename(value)
    return "jpeg" if value == "jpg" else value


def source_format_for_extension(
    filename_or_extension: str,
) -> SourceFormatPolicy | None:
    return SOURCE_FORMATS.get(normalized_extension(filename_or_extension))


def source_format_for_filename(filename: str) -> SourceFormatPolicy | None:
    return source_format_for_extension(extension_for_filename(filename))


def encoding_for_filename(filename: str) -> ImageEncoding | None:
    extension = normalized_extension(filename)
    return {
        "jpeg": JPEG,
        "png": PNG,
        "webp": WEBP,
        "heic": HEIC,
        "heif": HEIF,
    }.get(extension)


def save_variant(
    image: Image.Image,
    path: Path,
    encoding: ImageEncoding,
    size: tuple[int, int],
) -> None:
    variant = ImageOps.exif_transpose(image).copy()
    variant.thumbnail(size, Image.Resampling.LANCZOS)
    if encoding == JPEG and variant.mode not in ("RGB", "L"):
        variant = variant.convert("RGB")
    save_kwargs = {"quality": 88, "optimize": True} if encoding in {JPEG, WEBP} else {}
    variant.save(path, format=encoding.pillow_format, **save_kwargs)
