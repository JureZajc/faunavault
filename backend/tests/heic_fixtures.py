from __future__ import annotations

from io import BytesIO

from PIL import ExifTags, Image, ImageCms, TiffImagePlugin


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


def heic_bytes(
    color: str = "green",
    size: tuple[int, int] = (64, 32),
    *,
    metadata: bool = False,
    orientation: int | None = None,
    icc_profile: bool = False,
) -> bytes:
    exif = Image.Exif()
    if metadata:
        exif[int(ExifTags.Base.DateTimeOriginal)] = "2024:05:24 18:42:00"
        exif[int(ExifTags.Base.OffsetTimeOriginal)] = "+02:00"
        exif[int(ExifTags.Base.Make)] = "Apple"
        exif[int(ExifTags.Base.Model)] = "iPhone Test"
        exif[int(ExifTags.Base.LensModel)] = "Synthetic 26mm"
        exif[int(ExifTags.Base.GPSInfo)] = gps_ifd()
    if orientation is not None:
        exif[int(ExifTags.Base.Orientation)] = orientation
    output = BytesIO()
    save_options: dict[str, object] = {
        "format": "HEIF",
        "quality": 90,
        "exif": exif.tobytes() if exif else None,
    }
    if icc_profile:
        save_options["icc_profile"] = ImageCms.ImageCmsProfile(
            ImageCms.createProfile("sRGB")
        ).tobytes()
    Image.new("RGB", size, color).save(output, **save_options)
    return output.getvalue()


def multi_image_heic_bytes() -> bytes:
    output = BytesIO()
    first = Image.new("RGB", (48, 32), "red")
    primary = Image.new("RGB", (24, 40), "blue")
    first.save(
        output,
        format="HEIF",
        save_all=True,
        append_images=[primary],
        primary_index=1,
        quality=100,
    )
    return output.getvalue()
