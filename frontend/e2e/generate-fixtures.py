from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from PIL import Image, ImageDraw

from app.services.perceptual_duplicates import (
    PHASH_DISTANCE_THRESHOLD,
    hamming_distance,
    perceptual_hash,
)

ORIGINAL_FILENAME = "faunavault-e2e-original.jpg"
RECOMPRESSED_FILENAME = "faunavault-e2e-recompressed.jpg"


def scene() -> Image.Image:
    image = Image.new("RGB", (640, 480), (205, 224, 196))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 300, 640, 480), fill=(98, 142, 76))
    draw.ellipse(
        (110, 80, 430, 380),
        fill=(176, 103, 56),
        outline=(60, 38, 20),
        width=8,
    )
    draw.ellipse(
        (320, 130, 500, 300),
        fill=(196, 126, 70),
        outline=(60, 38, 20),
        width=7,
    )
    draw.ellipse((405, 105, 445, 145), fill=(20, 20, 20))
    draw.polygon([(475, 145), (590, 190), (480, 220)], fill=(40, 35, 25))
    draw.line((40, 40, 600, 410), fill=(30, 60, 90), width=10)
    return image


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image_hash(path: Path) -> str:
    with Image.open(path) as image:
        image.load()
        return perceptual_hash(image)


def generate(test_root: Path) -> None:
    fixtures = test_root / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=False)
    temporary_original = fixtures / f"{ORIGINAL_FILENAME}.tmp"
    temporary_recompressed = fixtures / f"{RECOMPRESSED_FILENAME}.tmp"
    original = fixtures / ORIGINAL_FILENAME
    recompressed = fixtures / RECOMPRESSED_FILENAME

    scene().save(temporary_original, format="JPEG", quality=95)
    with Image.open(temporary_original) as decoded:
        decoded.load()
        decoded.save(temporary_recompressed, format="JPEG", quality=55)

    if sha256(temporary_original) == sha256(temporary_recompressed):
        raise RuntimeError("E2E fixtures must be byte-different")
    distance = hamming_distance(
        image_hash(temporary_original), image_hash(temporary_recompressed)
    )
    if distance > PHASH_DISTANCE_THRESHOLD:
        raise RuntimeError(
            "E2E fixtures no longer exercise possible visual duplicates: "
            f"distance {distance} exceeds threshold {PHASH_DISTANCE_THRESHOLD}"
        )

    temporary_original.replace(original)
    temporary_recompressed.replace(recompressed)
    print(f"Generated deterministic E2E images with perceptual distance {distance}.")


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: generate-fixtures.py TEST_ROOT", file=sys.stderr)
        return 2
    generate(Path(sys.argv[1]).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
