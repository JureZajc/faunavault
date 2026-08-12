from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Literal


def normalize_legacy_species_group(value: str | None) -> str:
    return " ".join((value or "Unidentified").strip().lower().split())


def _encode_legacy_group(group: str) -> str:
    encoded = base64.urlsafe_b64encode(group.encode("utf-8")).decode("ascii")
    return f"legacy:{encoded.rstrip('=')}"


def legacy_album_key(value: str | None) -> str:
    return _encode_legacy_group(normalize_legacy_species_group(value))


def legacy_album_key_from_group(group: str) -> str:
    return _encode_legacy_group(group)


def taxon_album_key(taxon_id: int) -> str:
    return f"taxon:{taxon_id}"


@dataclass(frozen=True)
class AlbumIdentity:
    kind: Literal["taxon", "legacy"]
    taxon_id: int | None = None
    legacy_group: str | None = None


def parse_album_key(album_key: str) -> AlbumIdentity | None:
    if album_key.startswith("taxon:"):
        raw_id = album_key.removeprefix("taxon:")
        if not raw_id.isascii() or not raw_id.isdecimal() or raw_id.startswith("0"):
            return None
        taxon_id = int(raw_id)
        if taxon_id < 1 or taxon_album_key(taxon_id) != album_key:
            return None
        return AlbumIdentity(kind="taxon", taxon_id=taxon_id)

    if not album_key.startswith("legacy:"):
        return None
    encoded = album_key.removeprefix("legacy:")
    if "=" in encoded:
        return None
    try:
        padding = "=" * (-len(encoded) % 4)
        decoded = base64.b64decode(
            encoded + padding,
            altchars=b"-_",
            validate=True,
        ).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    if legacy_album_key_from_group(decoded) != album_key:
        return None
    if decoded and normalize_legacy_species_group(decoded) != decoded:
        return None
    return AlbumIdentity(kind="legacy", legacy_group=decoded)
