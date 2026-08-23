from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

from PIL import ExifTags, Image

MAX_CAMERA_TEXT_LENGTH = 200
_CAPTURE_FORMAT = "%Y:%m:%d %H:%M:%S"
_CAPTURE_PATTERN = re.compile(r"\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}")
_OFFSET_PATTERN = re.compile(r"([+-])(\d{2}):(\d{2})")
_ORIENTATIONS_THAT_SWAP_DIMENSIONS = {5, 6, 7, 8}


@dataclass(frozen=True)
class ExtractedPhotoMetadata:
    captured_at: datetime | None
    captured_at_offset_minutes: int | None
    camera_make: str | None
    camera_model: str | None
    lens_model: str | None
    image_width: int
    image_height: int
    latitude: float | None
    longitude: float | None


def _text(value: object, *, maximum: int = MAX_CAMERA_TEXT_LENGTH) -> str | None:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str):
        return None
    normalized = value.strip("\x00 \t\r\n")
    return normalized[:maximum] or None


def _tag(ifd: Mapping[int, object], root: Mapping[int, object], tag: int) -> object:
    return ifd.get(tag, root.get(tag))


def _capture_time(
    root: Mapping[int, object], exif_ifd: Mapping[int, object]
) -> tuple[datetime | None, int | None]:
    candidates = (
        (ExifTags.Base.DateTimeOriginal, ExifTags.Base.OffsetTimeOriginal),
        (ExifTags.Base.DateTimeDigitized, ExifTags.Base.OffsetTimeDigitized),
        (ExifTags.Base.DateTime, ExifTags.Base.OffsetTime),
    )
    for timestamp_tag, offset_tag in candidates:
        raw_timestamp = _text(_tag(exif_ifd, root, int(timestamp_tag)), maximum=64)
        if raw_timestamp is None or _CAPTURE_PATTERN.fullmatch(raw_timestamp) is None:
            continue
        try:
            captured_at = datetime.strptime(raw_timestamp, _CAPTURE_FORMAT)
        except ValueError:
            continue

        raw_offset = _text(_tag(exif_ifd, root, int(offset_tag)), maximum=16)
        if raw_offset is None:
            return captured_at, None
        match = _OFFSET_PATTERN.fullmatch(raw_offset)
        if match is None:
            return captured_at, None
        hours = int(match.group(2))
        minutes = int(match.group(3))
        if hours >= 24 or minutes >= 60:
            return captured_at, None
        total = hours * 60 + minutes
        if match.group(1) == "-":
            total = -total
        return captured_at, total
    return None, None


def _coordinate(value: object) -> float | None:
    if not isinstance(value, (tuple, list)) or len(value) != 3:
        return None
    try:
        degrees, minutes, seconds = (float(part) for part in value)
        if degrees < 0 or not 0 <= minutes < 60 or not 0 <= seconds < 60:
            return None
        result = degrees + minutes / 60 + seconds / 3600
    except (TypeError, ValueError, ZeroDivisionError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _gps_coordinates(gps: Mapping[int, object]) -> tuple[float | None, float | None]:
    latitude = _coordinate(gps.get(int(ExifTags.GPS.GPSLatitude)))
    longitude = _coordinate(gps.get(int(ExifTags.GPS.GPSLongitude)))
    latitude_ref = _text(gps.get(int(ExifTags.GPS.GPSLatitudeRef)), maximum=2)
    longitude_ref = _text(gps.get(int(ExifTags.GPS.GPSLongitudeRef)), maximum=2)
    if (
        latitude is None
        or longitude is None
        or latitude_ref is None
        or longitude_ref is None
    ):
        return None, None
    latitude_ref = latitude_ref.upper()
    longitude_ref = longitude_ref.upper()
    if latitude_ref not in {"N", "S"} or longitude_ref not in {"E", "W"}:
        return None, None
    if latitude_ref == "S":
        latitude = -latitude
    if longitude_ref == "W":
        longitude = -longitude
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        return None, None
    return latitude, longitude


def _safe_ifd(exif: Image.Exif, ifd: ExifTags.IFD) -> Mapping[int, object]:
    try:
        value = exif.get_ifd(ifd)
    except (KeyError, OSError, TypeError, ValueError, SyntaxError):
        return {}
    return value if isinstance(value, Mapping) else {}


def extract_photo_metadata(image: Image.Image) -> ExtractedPhotoMetadata:
    width, height = image.size
    root: Mapping[int, object] = {}
    exif_ifd: Mapping[int, object] = {}
    gps_ifd: Mapping[int, object] = {}
    try:
        exif = image.getexif()
        root = exif
        exif_ifd = _safe_ifd(exif, ExifTags.IFD.Exif)
        gps_ifd = _safe_ifd(exif, ExifTags.IFD.GPSInfo)
        if not exif_ifd:
            nested_exif = root.get(int(ExifTags.IFD.Exif))
            if isinstance(nested_exif, Mapping):
                exif_ifd = nested_exif
        if not gps_ifd:
            nested_gps = root.get(int(ExifTags.IFD.GPSInfo))
            if isinstance(nested_gps, Mapping):
                gps_ifd = nested_gps
    except Exception:
        root = {}
        exif_ifd = {}
        gps_ifd = {}

    orientation = root.get(int(ExifTags.Base.Orientation))
    try:
        if int(orientation) in _ORIENTATIONS_THAT_SWAP_DIMENSIONS:
            width, height = height, width
    except (TypeError, ValueError):
        pass

    captured_at, offset = _capture_time(root, exif_ifd)
    latitude, longitude = _gps_coordinates(gps_ifd)
    return ExtractedPhotoMetadata(
        captured_at=captured_at,
        captured_at_offset_minutes=offset,
        camera_make=_text(root.get(int(ExifTags.Base.Make))),
        camera_model=_text(root.get(int(ExifTags.Base.Model))),
        lens_model=_text(_tag(exif_ifd, root, int(ExifTags.Base.LensModel))),
        image_width=width,
        image_height=height,
        latitude=latitude,
        longitude=longitude,
    )
