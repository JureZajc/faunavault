from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageOps

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


def extension_for_filename(filename: str) -> str:
    return Path(filename).suffix.lower().lstrip(".")


def normalized_extension(filename_or_extension: str) -> str:
    value = filename_or_extension.lower().lstrip(".")
    if "." in value:
        value = extension_for_filename(value)
    return "jpeg" if value == "jpg" else value


def save_variant(
    image: Image.Image,
    path: Path,
    extension: str,
    size: tuple[int, int],
) -> None:
    extension = normalized_extension(extension)
    variant = ImageOps.exif_transpose(image).copy()
    variant.thumbnail(size, Image.Resampling.LANCZOS)
    if extension == "jpeg" and variant.mode not in ("RGB", "L"):
        variant = variant.convert("RGB")
    save_kwargs = (
        {"quality": 88, "optimize": True} if extension in {"jpeg", "webp"} else {}
    )
    variant.save(path, format=EXPECTED_FORMAT[extension], **save_kwargs)
