from __future__ import annotations

from typing import Any

from PIL import Image
from pillow_heif import register_heif_opener

register_heif_opener(thumbnails=False, depth_images=False, aux_images=False)


def open_image(source: Any) -> Image.Image:
    """Open an image with every FaunaVault-supported Pillow codec registered."""
    return Image.open(source)
