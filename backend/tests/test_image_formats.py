from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.services.image_codecs import open_image
from app.services.image_variants import (
    HEIC,
    HEIF,
    JPEG,
    PNG,
    WEBP,
    encoding_for_filename,
    normalized_extension,
    source_format_for_filename,
)


@pytest.mark.parametrize(
    ("filename", "source", "mime_type", "derivative"),
    [
        ("photo.jpg", JPEG, "image/jpeg", JPEG),
        ("photo.JPEG", JPEG, "image/jpeg", JPEG),
        ("photo.png", PNG, "image/png", PNG),
        ("photo.webp", WEBP, "image/webp", WEBP),
        ("photo.heic", HEIC, "image/heic", JPEG),
        ("photo.HEIC", HEIC, "image/heic", JPEG),
        ("photo.heif", HEIF, "image/heif", JPEG),
    ],
)
def test_source_and_derivative_format_policy(filename, source, mime_type, derivative):
    policy = source_format_for_filename(filename)

    assert policy is not None
    assert policy.source == source
    assert policy.accepted_media_types == {mime_type}
    assert policy.derivative == derivative


@pytest.mark.parametrize(
    "filename", ["photo.avif", "photo.hif", "photo.heics", "photo"]
)
def test_unsupported_heif_family_extensions_are_not_source_formats(filename):
    assert source_format_for_filename(filename) is None


def test_filename_encoding_and_jpg_normalization():
    assert normalized_extension("PHOTO.JPG") == "jpeg"
    assert encoding_for_filename("preview.jpeg") == JPEG
    assert encoding_for_filename("source.heic") == HEIC
    assert encoding_for_filename("unknown.bin") is None


def test_committed_external_heic_fixture_decodes_as_primary_image():
    fixture = Path(__file__).parent / "fixtures" / "heic" / "reference.heic"

    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == (
        "95138399b63bbda5cb9d08397b8c8c648031cfb8a9a308c2b5f260c4f946c121"
    )
    with open_image(fixture) as image:
        image.load()
        assert image.format == "HEIF"
        assert image.mode == "RGB"
        assert image.size == (29, 100)
