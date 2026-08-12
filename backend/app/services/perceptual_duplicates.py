from __future__ import annotations

import asyncio
import logging
import math
import re
import statistics
import warnings
from collections.abc import Awaitable, Callable
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import Engine
from sqlmodel import Session, func, select

from app.config import Settings
from app.models import Photo
from app.schemas import VisualDuplicateCandidate

logger = logging.getLogger(__name__)

PHASH_ALGORITHM = "phash64-v1"
PHASH_HEX_LENGTH = 16
PHASH_DISTANCE_THRESHOLD = 4
MAX_VISUAL_DUPLICATE_CANDIDATES = 3
BACKFILL_BATCH_SIZE = 25
BACKFILL_PAUSE_SECONDS = 0.1

_HASH_SIZE = 8
_IMAGE_SIZE = 32
_HEX_PATTERN = re.compile(r"[0-9a-f]{16}")
_DCT_BASIS = tuple(
    tuple(
        math.cos(math.pi * (2 * position + 1) * frequency / (2 * _IMAGE_SIZE))
        for position in range(_IMAGE_SIZE)
    )
    for frequency in range(_HASH_SIZE)
)


def is_valid_perceptual_hash(value: object) -> bool:
    return isinstance(value, str) and _HEX_PATTERN.fullmatch(value) is not None


def _canonical_grayscale(image: Image.Image) -> Image.Image:
    oriented = ImageOps.exif_transpose(image)
    has_transparency = oriented.mode in {"RGBA", "LA"} or (
        oriented.mode == "P" and "transparency" in oriented.info
    )
    if has_transparency:
        rgba = oriented.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        rgb = Image.alpha_composite(background, rgba).convert("RGB")
    else:
        rgb = oriented.convert("RGB")
    return rgb.convert("L").resize((_IMAGE_SIZE, _IMAGE_SIZE), Image.Resampling.LANCZOS)


def perceptual_hash(image: Image.Image) -> str:
    pixels = list(_canonical_grayscale(image).get_flattened_data())
    row_coefficients = [
        [
            sum(
                _DCT_BASIS[frequency][position] * pixels[row * _IMAGE_SIZE + position]
                for position in range(_IMAGE_SIZE)
            )
            for frequency in range(_HASH_SIZE)
        ]
        for row in range(_IMAGE_SIZE)
    ]
    coefficients = [
        sum(
            _DCT_BASIS[vertical_frequency][row]
            * row_coefficients[row][horizontal_frequency]
            for row in range(_IMAGE_SIZE)
        )
        for vertical_frequency in range(_HASH_SIZE)
        for horizontal_frequency in range(_HASH_SIZE)
    ]
    median = statistics.median(coefficients)
    value = sum(
        (coefficient > median) << (63 - index)
        for index, coefficient in enumerate(coefficients)
    )
    return f"{value:016x}"


def perceptual_hash_for_path(path: Path, max_image_pixels: int) -> str:
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path) as image:
            width, height = image.size
            if width * height > max_image_pixels:
                raise ValueError("Image dimensions are too large")
            image.load()
            return perceptual_hash(image)


def hamming_distance(left: str, right: str) -> int:
    if not is_valid_perceptual_hash(left) or not is_valid_perceptual_hash(right):
        raise ValueError(
            "Perceptual hashes must be 16 lowercase hexadecimal characters"
        )
    return (int(left, 16) ^ int(right, 16)).bit_count()


def find_visual_duplicate_candidates(
    session: Session,
    uploaded_hash: str,
    *,
    threshold: int = PHASH_DISTANCE_THRESHOLD,
    limit: int = MAX_VISUAL_DUPLICATE_CANDIDATES,
) -> list[VisualDuplicateCandidate]:
    matches: list[VisualDuplicateCandidate] = []
    rows = session.exec(
        select(
            Photo.id,
            Photo.perceptual_hash,
            Photo.original_filename,
            Photo.display_title,
            Photo.common_name,
            Photo.species_guess,
            Photo.deleted_at,
        ).where(Photo.perceptual_hash.is_not(None))
    ).all()
    for row in rows:
        photo_id = int(row[0])
        stored_hash = row[1]
        if not is_valid_perceptual_hash(stored_hash):
            logger.warning(
                "Skipping malformed perceptual hash for photo id %s", photo_id
            )
            continue
        distance = hamming_distance(uploaded_hash, stored_hash)
        if distance > threshold:
            continue
        matches.append(
            VisualDuplicateCandidate(
                photo_id=photo_id,
                original_filename=str(row[2]),
                display_title=row[3],
                common_name=row[4],
                species_guess=row[5],
                location="trash" if row[6] is not None else "catalog",
                hamming_distance=distance,
            )
        )
        matches.sort(
            key=lambda candidate: (
                candidate.hamming_distance,
                1 if candidate.location == "trash" else 0,
                -candidate.photo_id,
            )
        )
        del matches[limit:]
    return matches


def _safe_original_path(settings: Settings, filename: str) -> Path | None:
    raw_path = Path(filename)
    if not filename or raw_path.name != filename or raw_path.name in {".", ".."}:
        return None
    original_dir = settings.image_dirs["original"].resolve()
    candidate = (original_dir / raw_path.name).resolve()
    try:
        candidate.relative_to(original_dir)
    except ValueError:
        return None
    return candidate if candidate.parent == original_dir else None


async def run_perceptual_hash_backfill(
    engine: Engine,
    settings: Settings,
    *,
    batch_size: int = BACKFILL_BATCH_SIZE,
    pause_seconds: float = BACKFILL_PAUSE_SECONDS,
    pause: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> tuple[int, int]:
    with Session(engine) as session:
        pending = session.exec(
            select(func.count())
            .select_from(Photo)
            .where(Photo.perceptual_hash.is_(None))
        ).one()
    if pending == 0:
        return 0, 0

    logger.info(
        "Starting %s perceptual hash backfill for %s photo(s)",
        PHASH_ALGORITHM,
        pending,
    )
    cursor = 0
    processed = 0
    skipped = 0
    last_progress = 0
    while True:
        with Session(engine) as session:
            rows = list(
                session.exec(
                    select(Photo.id, Photo.stored_filename)
                    .where(Photo.perceptual_hash.is_(None), Photo.id > cursor)
                    .order_by(Photo.id)
                    .limit(batch_size)
                ).all()
            )
        if not rows:
            break

        updates: list[tuple[int, str]] = []
        skipped_ids: list[int] = []
        for photo_id, filename in rows:
            cursor = int(photo_id)
            path = _safe_original_path(settings, str(filename))
            if path is None or not path.is_file():
                skipped += 1
                skipped_ids.append(cursor)
                continue
            try:
                value = await asyncio.to_thread(
                    perceptual_hash_for_path, path, settings.max_image_pixels
                )
            except (
                Image.DecompressionBombError,
                Image.DecompressionBombWarning,
                UnidentifiedImageError,
                OSError,
                ValueError,
            ):
                skipped += 1
                skipped_ids.append(cursor)
                continue
            updates.append((cursor, value))

        if updates:
            with Session(engine) as session:
                for photo_id, value in updates:
                    photo = session.get(Photo, photo_id)
                    if photo is not None and photo.perceptual_hash is None:
                        photo.perceptual_hash = value
                        session.add(photo)
                session.commit()
        processed += len(rows)
        if skipped_ids:
            logger.warning(
                "Perceptual hash backfill skipped photo ids: %s",
                ", ".join(str(photo_id) for photo_id in skipped_ids),
            )
        if processed - last_progress >= 100:
            logger.info(
                "Perceptual hash backfill processed %s/%s photo(s)",
                min(processed, pending),
                pending,
            )
            last_progress = processed
        await pause(pause_seconds)

    logger.info(
        "Perceptual hash backfill complete: %s processed, %s skipped",
        processed,
        skipped,
    )
    return processed, skipped
