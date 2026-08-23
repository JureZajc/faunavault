from __future__ import annotations

import hashlib
import sys
from pathlib import Path

from PIL import ExifTags, Image, ImageDraw, TiffImagePlugin

from app.services.perceptual_duplicates import (
    PHASH_DISTANCE_THRESHOLD,
    hamming_distance,
    perceptual_hash,
)

ORIGINAL_FILENAME = "faunavault-e2e-original.jpg"
RECOMPRESSED_FILENAME = "faunavault-e2e-recompressed.jpg"
BULK_FIRST_FILENAME = "faunavault-e2e-bulk-first.jpg"
BULK_SECOND_FILENAME = "faunavault-e2e-bulk-second.jpg"
HEIC_FILENAME = "faunavault-e2e-iphone.heic"


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


def bulk_scene(variant: int) -> Image.Image:
    image = Image.new("RGB", (640, 480), (235, 230, 210))
    draw = ImageDraw.Draw(image)
    if variant == 1:
        for offset in range(0, 640, 80):
            draw.rectangle((offset, 0, offset + 39, 480), fill=(40, 105, 150))
        draw.ellipse((170, 90, 470, 390), fill=(235, 175, 45), outline=(20, 20, 20), width=12)
    else:
        for offset in range(0, 480, 60):
            draw.rectangle((0, offset, 640, offset + 29), fill=(145, 55, 95))
        draw.polygon([(320, 35), (590, 430), (50, 430)], fill=(70, 175, 105))
    return image


def heic_scene() -> Image.Image:
    image = Image.new("RGB", (720, 540), (33, 48, 76))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 360, 720, 540), fill=(205, 145, 54))
    draw.polygon([(80, 330), (275, 65), (470, 330)], fill=(88, 170, 132))
    draw.polygon([(300, 330), (520, 90), (690, 330)], fill=(182, 83, 98))
    draw.ellipse((525, 35, 655, 165), fill=(248, 225, 120))
    draw.rectangle((42, 390, 678, 455), fill=(45, 75, 115))
    return image


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image_hash(path: Path) -> str:
    with Image.open(path) as image:
        image.load()
        return perceptual_hash(image)


def gps_ifd() -> dict[int, object]:
    rational = TiffImagePlugin.IFDRational
    return {
        int(ExifTags.GPS.GPSLatitudeRef): "N",
        int(ExifTags.GPS.GPSLatitude): (
            rational(46, 1),
            rational(7, 1),
            rational(2442, 100),
        ),
        int(ExifTags.GPS.GPSLongitudeRef): "E",
        int(ExifTags.GPS.GPSLongitude): (
            rational(14, 1),
            rational(32, 1),
            rational(3556, 100),
        ),
    }


def generate(test_root: Path) -> None:
    fixtures = test_root / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=False)
    temporary_original = fixtures / f"{ORIGINAL_FILENAME}.tmp"
    temporary_recompressed = fixtures / f"{RECOMPRESSED_FILENAME}.tmp"
    original = fixtures / ORIGINAL_FILENAME
    recompressed = fixtures / RECOMPRESSED_FILENAME
    bulk_first = fixtures / BULK_FIRST_FILENAME
    bulk_second = fixtures / BULK_SECOND_FILENAME
    heic = fixtures / HEIC_FILENAME

    exif = Image.Exif()
    exif[int(ExifTags.Base.DateTimeOriginal)] = "2026:08:22 14:30:00"
    exif[int(ExifTags.Base.GPSInfo)] = gps_ifd()
    scene().save(temporary_original, format="JPEG", quality=95, exif=exif)
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
    bulk_scene(1).save(bulk_first, format="JPEG", quality=92)
    bulk_scene(2).save(bulk_second, format="JPEG", quality=92)

    heic_exif = Image.Exif()
    heic_exif[int(ExifTags.Base.DateTimeOriginal)] = "2026:08:23 09:15:00"
    heic_exif[int(ExifTags.Base.OffsetTimeOriginal)] = "+02:00"
    heic_exif[int(ExifTags.Base.Make)] = "Apple"
    heic_exif[int(ExifTags.Base.Model)] = "iPhone Test"
    heic_exif[int(ExifTags.Base.LensModel)] = "Synthetic HEIC Lens"
    heic_scene().save(heic, format="HEIF", quality=90, exif=heic_exif)

    fixture_hashes = [
        image_hash(path) for path in (original, bulk_first, bulk_second, heic)
    ]
    for first_index, first_hash in enumerate(fixture_hashes):
        for second_hash in fixture_hashes[first_index + 1 :]:
            fixture_distance = hamming_distance(first_hash, second_hash)
            if fixture_distance <= PHASH_DISTANCE_THRESHOLD:
                raise RuntimeError(
                    "Bulk E2E fixtures must not trigger possible-duplicate review: "
                    f"distance {fixture_distance} is within threshold"
                )
    print(f"Generated deterministic E2E images with perceptual distance {distance}.")


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: generate-fixtures.py TEST_ROOT", file=sys.stderr)
        return 2
    generate(Path(sys.argv[1]).resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
