"""Ephemeral, selected-original ZIP downloads; independent of archive/backup formats."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, BinaryIO, Literal, NoReturn
from zipfile import ZIP_STORED, BadZipFile, ZipFile

from fastapi import HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
)
from sqlmodel import Session, select

from app.archive_integrity import (
    CHUNK_SIZE,
    ArchiveIntegrityError,
    contains_link_or_junction,
    file_identity,
    hash_file_stable,
    validate_flat_filename,
)
from app.config import Settings
from app.models import Animal, Photo, Taxon
from app.services.image_variants import source_format_for_extension
from app.services.photo_lifecycle import safe_original_filename, stored_image_path

DOWNLOAD_TTL_SECONDS = 300
MAX_PENDING_EXPORTS = 2  # Includes preparation and active downloads; bounds disk use.


class SelectedExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    photo_ids: list[Annotated[StrictInt, Field(gt=0, le=2**63 - 1)]] = Field(
        min_length=1, max_length=250
    )
    mode: Literal["originals"] = "originals"
    include_metadata: StrictBool = False

    @field_validator("photo_ids")
    @classmethod
    def unique_ids(cls, ids: list[int]) -> list[int]:
        if len(ids) != len(set(ids)):
            raise ValueError("photo_ids must be unique")
        return sorted(ids)


def fail(code: str, message: str, status: int = 422) -> NoReturn:
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def snapshot(session: Session, ids: list[int]) -> list[dict]:
    # One joined statement captures photo + taxonomy metadata consistently. Convert
    # immediately so later ORM identity-map refreshes cannot alter the snapshot.
    rows = session.exec(
        select(Photo, Animal, Taxon)
        .outerjoin(Animal, Photo.animal_id == Animal.id)
        .outerjoin(Taxon, Animal.taxon_id == Taxon.id)
        .where(Photo.id.in_(ids))
        .order_by(Photo.id)
        .execution_options(populate_existing=True)
    ).all()
    result = [
        {
            "photo": photo.model_dump(mode="json"),
            "animal": animal.model_dump(mode="json") if animal else None,
            "taxon": taxon.model_dump(mode="json") if taxon else None,
        }
        for photo, animal, taxon in rows
    ]
    if len(result) != len(ids) or any(row["photo"]["deleted_at"] for row in result):
        fail(
            "export_photo_unavailable",
            "Selected photos are missing or in Trash. Refresh your selection.",
            409,
        )
    return result


def original_path(photo: dict, settings: Settings) -> Path:
    try:
        filename = photo["stored_filename"]
        validate_flat_filename(filename)
        raw = settings.image_dirs["original"] / filename
        policy = source_format_for_extension(filename)
        if policy is None:
            fail(
                "export_unsupported_format",
                f"Photo {photo['id']} has an unsupported original format.",
            )
        if photo["media_type"] not in (None, policy.source.media_type):
            raise ValueError("media type mismatch")
        if contains_link_or_junction(raw):
            raise ValueError("linked original")
        path = stored_image_path(settings, "original", filename)
        if path is None or not path.is_file():
            raise ValueError("missing original")
        return path
    except (ArchiveIntegrityError, OSError, ValueError):
        fail(
            "export_original_unavailable",
            f"Photo {photo['id']}: original is missing, unsafe, or changed.",
        )


def member_path(photo: dict) -> str:
    # Prefixing the immutable ID resolves duplicate names even on case-insensitive
    # extractors. Retain Unicode letters, but remove path/control/reserved characters.
    name = safe_original_filename(photo["original_filename"])
    stem = re.sub(r"[^\w .-]", "_", Path(name).stem, flags=re.UNICODE)
    # Bound the encoded component for portable extraction of long Unicode names.
    stem = (
        stem.strip(" .")
        .encode("utf-8")[:160]
        .decode("utf-8", errors="ignore")
        .rstrip(" .")
        or "photo"
    )
    stored_suffix = Path(photo["stored_filename"]).suffix
    suffix = Path(name).suffix
    if source_format_for_extension(suffix) != source_format_for_extension(
        stored_suffix
    ):
        suffix = stored_suffix
    return f"photos/{photo['id']}-{stem}{suffix}"


def estimate_export(
    request: SelectedExportRequest, session: Session, settings: Settings
):
    rows = snapshot(session, request.photo_ids)
    total = 0
    for row in rows:
        photo = row["photo"]
        try:
            size = file_identity(original_path(photo, settings)).size
        except ArchiveIntegrityError:
            fail(
                "export_original_unavailable",
                f"Photo {photo['id']}: original is missing or changed.",
            )
        if photo["original_size_bytes"] not in (None, size):
            fail(
                "export_original_changed",
                f"Photo {photo['id']}: original size changed.",
                409,
            )
        total += size
        if total > settings.max_selected_export_bytes:
            fail(
                "export_size_limit",
                "Selection exceeds the selected export size limit. Select fewer photos.",
                413,
            )
    # ZIP_STORED, plus conservative headers/manifest allowance. Preparation returns
    # the exact byte count. No file bytes are read for this preliminary estimate.
    return {
        "selected_count": len(rows),
        "original_bytes": total,
        "estimated_download_bytes": total
        + len(rows) * (16384 if request.include_metadata else 1024)
        + 1024,
        "max_original_bytes": settings.max_selected_export_bytes,
    }


@dataclass
class PreparedExport:
    file: BinaryIO
    size: int

    def close(self):
        self.file.close()


class ExportStore:
    def __init__(self):
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(MAX_PENDING_EXPORTS)
        self.pending: dict[str, tuple[PreparedExport, threading.Timer]] = {}

    def publish(self, artifact: PreparedExport) -> str:
        token = secrets.token_urlsafe(32)
        timer = threading.Timer(DOWNLOAD_TTL_SECONDS, self.expire, args=(token,))
        timer.daemon = True
        with self.lock:
            self.pending[token] = (artifact, timer)
            try:
                timer.start()
            except RuntimeError:
                self.pending.pop(token)
                raise
        return token

    def take(self, token: str) -> PreparedExport:
        with self.lock:
            entry = self.pending.pop(token, None)
        if entry is None:
            fail(
                "export_expired",
                "Download expired or was already used. Prepare the export again.",
                410,
            )
        artifact, timer = entry
        timer.cancel()
        return artifact

    def expire(self, token: str):
        with self.lock:
            entry = self.pending.pop(token, None)
        if entry:
            artifact, timer = entry
            timer.cancel()
            try:
                artifact.close()
            finally:
                self.slots.release()

    def close(self):
        with self.lock:
            tokens = list(self.pending)
        for token in tokens:
            self.expire(token)


exports = ExportStore()


def prepare_export(
    request: SelectedExportRequest, session: Session, settings: Settings
):
    if not exports.slots.acquire(blocking=False):
        fail(
            "export_busy",
            "Two exports are already preparing or downloading. Retry after they finish or expire.",
            429,
        )
    output = None
    try:
        estimate_export(request, session, settings)
        rows = snapshot(session, request.photo_ids)
        session.rollback()  # Do not retain a database read transaction during file IO.
        output = tempfile.TemporaryFile(mode="w+b", prefix="faunavault-selected-")
        manifest = []
        expected = {}
        total = 0
        with ZipFile(
            output, mode="w", compression=ZIP_STORED, allowZip64=True
        ) as archive:
            for row in rows:
                photo = row["photo"]
                path = original_path(photo, settings)
                if (
                    total + file_identity(path).size
                    > settings.max_selected_export_bytes
                ):
                    fail(
                        "export_size_limit",
                        "Selection exceeds the selected export size limit.",
                        413,
                    )
                digest, size, identity = hash_file_stable(path)
                if photo["content_sha256"] not in (None, digest) or photo[
                    "original_size_bytes"
                ] not in (None, size):
                    fail(
                        "export_original_changed",
                        f"Photo {photo['id']}: original checksum or size changed.",
                        409,
                    )
                total += size
                if total > settings.max_selected_export_bytes:
                    fail(
                        "export_size_limit",
                        "Selection exceeds the selected export size limit.",
                        413,
                    )
                member = member_path(photo)
                copied = hashlib.sha256()
                copied_size = 0
                with (
                    path.open("rb") as source,
                    archive.open(member, "w", force_zip64=True) as target,
                ):
                    while chunk := source.read(CHUNK_SIZE):
                        copied_size += len(chunk)
                        if copied_size > size:
                            fail(
                                "export_original_changed",
                                f"Photo {photo['id']}: original changed while exporting.",
                                409,
                            )
                        copied.update(chunk)
                        target.write(chunk)
                if (
                    copied.hexdigest() != digest
                    or copied_size != size
                    or original_path(photo, settings) != path
                    or file_identity(path) != identity
                ):
                    fail(
                        "export_original_changed",
                        f"Photo {photo['id']}: original changed while exporting.",
                        409,
                    )
                expected[member] = digest
                metadata = {
                    key: photo[key]
                    for key in (
                        "id",
                        "captured_at",
                        "captured_at_offset_minutes",
                        "latitude",
                        "longitude",
                        "category",
                        "status",
                        "tags",
                        "is_favorite",
                        "rating",
                        "culling_state",
                    )
                }
                metadata.update(
                    original_filename=safe_original_filename(
                        photo["original_filename"]
                    ),
                    zip_member_path=member,
                    original_sha256=digest,
                    verified_taxonomy=row["taxon"],
                )
                manifest.append(metadata)
            if request.include_metadata:
                manifest_bytes = json.dumps(
                    {
                        "format": "faunavault-selected-photos",
                        "format_version": 1,
                        "mode": "originals",
                        "photos": manifest,
                    },
                    ensure_ascii=False,
                    indent=2,
                ).encode("utf-8")
                if len(manifest_bytes) > 8 * 1024**2:
                    fail(
                        "export_metadata_limit",
                        "Selected metadata exceeds 8 MiB. Select fewer photos or omit the manifest.",
                        413,
                    )
                archive.writestr("metadata.json", manifest_bytes)
                expected["metadata.json"] = hashlib.sha256(manifest_bytes).hexdigest()
        # Re-read the finished ZIP, including CRC and SHA-256, before returning a
        # successful preparation. All reads and writes use bounded chunks.
        output.seek(0)
        with ZipFile(output) as archive:
            if archive.namelist() != list(expected):
                fail(
                    "export_verification_failed",
                    "ZIP membership verification failed. Retry the export.",
                    500,
                )
            for member in archive.infolist():
                digest = hashlib.sha256()
                with archive.open(member) as source:
                    while chunk := source.read(CHUNK_SIZE):
                        digest.update(chunk)
                if digest.hexdigest() != expected[member.filename]:
                    fail(
                        "export_verification_failed",
                        "ZIP verification failed. Retry the export.",
                        500,
                    )
        if snapshot(session, request.photo_ids) != rows:
            fail(
                "export_photo_changed",
                "Selected photos or taxonomy changed during export. Retry with current metadata.",
                409,
            )
        size = output.seek(0, 2)
        output.seek(0)
        token = exports.publish(PreparedExport(output, size))
        return {
            "download_path": f"/exports/selected/{token}",
            "download_bytes": size,
            "expires_in_seconds": DOWNLOAD_TTL_SECONDS,
        }
    except BaseException as exc:
        try:
            if output is not None:
                output.close()
        finally:
            exports.slots.release()
        if isinstance(exc, BadZipFile):
            fail(
                "export_verification_failed",
                "ZIP verification failed. Retry the export.",
                500,
            )
        if isinstance(exc, (OSError, ArchiveIntegrityError)):
            fail(
                "export_original_unavailable",
                "Could not safely read originals or write the temporary ZIP. Check storage and retry.",
            )
        raise
