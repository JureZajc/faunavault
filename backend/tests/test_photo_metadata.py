from __future__ import annotations

from io import BytesIO

import pytest
from PIL import ExifTags, Image, TiffImagePlugin

from app.services.photo_metadata import extract_photo_metadata


def image_with_exif(exif: Image.Exif | None = None, size=(40, 20)) -> Image.Image:
    output = BytesIO()
    kwargs = {"exif": exif} if exif is not None else {}
    Image.new("RGB", size, "green").save(output, format="JPEG", **kwargs)
    output.seek(0)
    image = Image.open(output)
    image.load()
    return image


def test_capture_precedence_offset_and_camera_cleanup():
    exif = Image.Exif()
    exif[int(ExifTags.Base.DateTimeOriginal)] = " 2024:05:24 18:42:00 "
    exif[int(ExifTags.Base.OffsetTimeOriginal)] = "+02:30"
    exif[int(ExifTags.Base.DateTimeDigitized)] = "2023:01:02 03:04:05"
    exif[int(ExifTags.Base.Make)] = b" SONY\x00 "
    exif[int(ExifTags.Base.Model)] = " ILCE-7M4 "
    exif[int(ExifTags.Base.LensModel)] = " FE 200-600mm "

    with image_with_exif(exif) as image:
        metadata = extract_photo_metadata(image)

    assert metadata.captured_at.isoformat() == "2024-05-24T18:42:00"
    assert metadata.captured_at.tzinfo is None
    assert metadata.captured_at_offset_minutes == 150
    assert metadata.camera_make == "SONY"
    assert metadata.camera_model == "ILCE-7M4"
    assert metadata.lens_model == "FE 200-600mm"


def test_malformed_preferred_date_falls_back_without_fabricating_timezone():
    exif = Image.Exif()
    exif[int(ExifTags.Base.DateTimeOriginal)] = "not-a-date"
    exif[int(ExifTags.Base.OffsetTimeOriginal)] = "+01:00"
    exif[int(ExifTags.Base.DateTimeDigitized)] = "2022:11:10 09:08:07"
    exif[int(ExifTags.Base.OffsetTimeDigitized)] = "invalid"
    exif[int(ExifTags.Base.OffsetTime)] = "+09:00"

    with image_with_exif(exif) as image:
        metadata = extract_photo_metadata(image)

    assert metadata.captured_at.isoformat() == "2022-11-10T09:08:07"
    assert metadata.captured_at_offset_minutes is None


def test_capture_date_requires_fixed_exif_shape_and_text_is_truncated():
    exif = Image.Exif()
    exif[int(ExifTags.Base.DateTimeOriginal)] = "2024:5:24 8:42:00"
    exif[int(ExifTags.Base.DateTimeDigitized)] = "2024:05:24 08:42:00"
    exif[int(ExifTags.Base.Make)] = " X" * 150

    with image_with_exif(exif) as image:
        metadata = extract_photo_metadata(image)

    assert metadata.captured_at.isoformat() == "2024-05-24T08:42:00"
    assert len(metadata.camera_make) == 200


@pytest.mark.parametrize("offset", ["24:00", "+24:00", "+02:60", "Z", ""])
def test_invalid_offsets_leave_valid_camera_time_naive(offset):
    exif = Image.Exif()
    exif[int(ExifTags.Base.DateTime)] = "2021:01:02 03:04:05"
    exif[int(ExifTags.Base.OffsetTime)] = offset

    with image_with_exif(exif) as image:
        metadata = extract_photo_metadata(image)

    assert metadata.captured_at is not None
    assert metadata.captured_at_offset_minutes is None


def test_orientation_produces_logical_dimensions_without_persisting_orientation():
    exif = Image.Exif()
    exif[int(ExifTags.Base.Orientation)] = 6
    with image_with_exif(exif, size=(40, 20)) as image:
        metadata = extract_photo_metadata(image)

    assert (metadata.image_width, metadata.image_height) == (20, 40)


def gps_exif(latitude_ref="N", longitude_ref="E", latitude=None, longitude=None):
    latitude = latitude or ((46, 1), (7, 1), (2442, 100))
    longitude = longitude or ((14, 1), (32, 1), (3556, 100))

    def rational(item):
        return TiffImagePlugin.IFDRational(*item)

    exif = Image.Exif()
    exif[int(ExifTags.Base.GPSInfo)] = {
        int(ExifTags.GPS.GPSLatitudeRef): latitude_ref,
        int(ExifTags.GPS.GPSLatitude): tuple(rational(item) for item in latitude),
        int(ExifTags.GPS.GPSLongitudeRef): longitude_ref,
        int(ExifTags.GPS.GPSLongitude): tuple(rational(item) for item in longitude),
    }
    return exif


@pytest.mark.parametrize(
    ("latitude_ref", "longitude_ref", "latitude_sign", "longitude_sign"),
    [("N", "E", 1, 1), ("S", "W", -1, -1)],
)
def test_gps_rationals_and_hemisphere_signs(
    latitude_ref, longitude_ref, latitude_sign, longitude_sign
):
    with image_with_exif(gps_exif(latitude_ref, longitude_ref)) as image:
        metadata = extract_photo_metadata(image)

    assert metadata.latitude == pytest.approx(latitude_sign * 46.12345)
    assert metadata.longitude == pytest.approx(longitude_sign * 14.5432111111)


def test_incomplete_or_out_of_range_gps_is_atomic_null():
    incomplete = gps_exif()
    del incomplete[int(ExifTags.Base.GPSInfo)][int(ExifTags.GPS.GPSLongitude)]
    with image_with_exif(incomplete) as image:
        missing = extract_photo_metadata(image)

    out_of_range = gps_exif(latitude=((91, 1), (0, 1), (0, 1)))
    with image_with_exif(out_of_range) as image:
        invalid = extract_photo_metadata(image)

    assert (missing.latitude, missing.longitude) == (None, None)
    assert (invalid.latitude, invalid.longitude) == (None, None)


def test_malformed_dms_and_root_ifd_fallbacks():
    malformed = gps_exif(latitude=((46, 1), (60, 1), (0, 1)))
    with image_with_exif(malformed) as image:
        invalid = extract_photo_metadata(image)
    assert (invalid.latitude, invalid.longitude) == (None, None)

    class RootExif(dict):
        def get_ifd(self, _ifd):
            raise KeyError

    class SyntheticImage:
        size = (30, 20)

        def getexif(self):
            return RootExif(gps_exif())

    fallback = extract_photo_metadata(SyntheticImage())
    assert fallback.latitude == pytest.approx(46.12345)
    assert fallback.longitude == pytest.approx(14.5432111111)


def test_no_exif_returns_dimensions_and_nullable_metadata():
    with image_with_exif() as image:
        metadata = extract_photo_metadata(image)

    assert (metadata.image_width, metadata.image_height) == (40, 20)
    assert metadata.captured_at is None
    assert metadata.camera_make is None
    assert metadata.latitude is None
