from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

BACKUP_FORMAT_VERSION = 1
DATABASE_BACKUP_PATH = "database/faunavault.db"
INCLUDED_IMAGE_VARIANTS = ["original", "resized", "thumbs"]
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")

FileRole = Literal["database", "original", "resized", "thumbs"]


def validate_relative_path(value: str) -> str:
    if not value or "\\" in value:
        raise ValueError("backup paths must be non-empty POSIX paths")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("backup paths must be normalized and relative")
    if path.as_posix() != value:
        raise ValueError("backup paths must be normalized")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ApplicationInfo(StrictModel):
    name: Literal["FaunaVault"] = "FaunaVault"
    version: str = Field(min_length=1)


class DatabaseInfo(StrictModel):
    path: Literal[DATABASE_BACKUP_PATH] = DATABASE_BACKUP_PATH
    schema_version: int = Field(ge=1)
    applied_migrations: list[int]

    @model_validator(mode="after")
    def validate_migrations(self) -> DatabaseInfo:
        expected = list(range(1, self.schema_version + 1))
        if self.applied_migrations != expected:
            raise ValueError(
                "applied migrations must be contiguous through schema version"
            )
        return self


class ClassificationJobCounts(StrictModel):
    total: int = Field(ge=0)
    queued: int = Field(ge=0)
    running: int = Field(ge=0)
    succeeded: int = Field(ge=0)
    failed: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_total(self) -> ClassificationJobCounts:
        if self.total != self.queued + self.running + self.succeeded + self.failed:
            raise ValueError("classification job status counts do not match total")
        return self


class ImageCounts(StrictModel):
    original: int = Field(ge=0)
    resized: int = Field(ge=0)
    thumbs: int = Field(ge=0)


class ArchiveCounts(StrictModel):
    photos: int = Field(ge=0)
    active_photos: int = Field(ge=0)
    trashed_photos: int = Field(ge=0)
    animals: int = Field(ge=0)
    taxa: int = Field(ge=0)
    classification_jobs: ClassificationJobCounts
    images: ImageCounts
    payload_files: int = Field(ge=1)
    payload_bytes: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_photo_counts(self) -> ArchiveCounts:
        if self.photos != self.active_photos + self.trashed_photos:
            raise ValueError("active and trashed photo counts do not match total")
        return self


class BackupFile(StrictModel):
    path: str
    role: FileRole
    size_bytes: int = Field(ge=0)
    sha256: str
    photo_id: int | None = Field(default=None, ge=1)

    _relative_path = field_validator("path")(validate_relative_path)

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not SHA256_PATTERN.fullmatch(value):
            raise ValueError("sha256 must contain 64 lowercase hexadecimal characters")
        return value

    @model_validator(mode="after")
    def validate_role_layout(self) -> BackupFile:
        if self.role == "database":
            if self.path != DATABASE_BACKUP_PATH or self.photo_id is not None:
                raise ValueError("database entry does not match the v1 layout")
            return self
        if self.photo_id is None or not self.path.startswith(f"images/{self.role}/"):
            raise ValueError("image entry does not match its role or photo")
        if len(PurePosixPath(self.path).parts) != 3:
            raise ValueError("image payload paths must be flat within their variant")
        return self


class SourceWarning(StrictModel):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    path: str | None = None

    @field_validator("path")
    @classmethod
    def validate_optional_path(cls, value: str | None) -> str | None:
        return validate_relative_path(value) if value is not None else None


class SourceDiagnostics(StrictModel):
    source_database_path: str | None = None
    source_image_root: str | None = None


class BackupManifest(StrictModel):
    backup_format_version: Literal[BACKUP_FORMAT_VERSION]
    backup_id: str = Field(min_length=1)
    created_at_utc: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}T.*Z$")
    application: ApplicationInfo
    backup_tool_version: str = Field(min_length=1)
    database: DatabaseInfo
    included_image_variants: list[Literal["original", "resized", "thumbs"]]
    counts: ArchiveCounts
    files: list[BackupFile]
    source_warnings: list[SourceWarning]
    diagnostics: SourceDiagnostics | None = None

    @field_validator("backup_id")
    @classmethod
    def validate_backup_id(cls, value: str) -> str:
        try:
            UUID(value)
        except ValueError as exc:
            raise ValueError("backup_id must be a UUID") from exc
        return value

    @field_validator("created_at_utc")
    @classmethod
    def validate_created_at(cls, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("created_at_utc must be an ISO-8601 timestamp") from exc
        if parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
            raise ValueError("created_at_utc must use UTC")
        return value

    @model_validator(mode="after")
    def validate_file_set(self) -> BackupManifest:
        if self.included_image_variants != INCLUDED_IMAGE_VARIANTS:
            raise ValueError("backup format v1 requires all image variants")
        paths = [item.path for item in self.files]
        folded = [path.casefold() for path in paths]
        if paths != sorted(paths):
            raise ValueError("manifest file entries must be sorted by path")
        if len(paths) != len(set(paths)) or len(folded) != len(set(folded)):
            raise ValueError("manifest contains duplicate or case-colliding paths")
        if self.counts.payload_files != len(self.files):
            raise ValueError("payload file count does not match file entries")
        if self.counts.payload_bytes != sum(item.size_bytes for item in self.files):
            raise ValueError("payload byte count does not match file entries")
        return self


def read_manifest(path: Path) -> BackupManifest:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return BackupManifest.model_validate(payload)


def write_manifest(path: Path, manifest: BackupManifest) -> None:
    payload = manifest.model_dump(mode="json", exclude_none=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
