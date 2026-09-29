from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

from pydantic_settings import BaseSettings
from sqlalchemy.engine import make_url

from app.archive_integrity import is_link_or_junction
from app.config import BACKEND_DIR, Settings


class BenchmarkError(RuntimeError):
    """A safety or correctness check failed; no valid report can be published."""


class IsolatedSettings(Settings):
    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, **_sources):
        return (init_settings,)


class StorageLocations(BaseSettings):
    """Read only storage configuration for refusal checks, never create an engine."""

    model_config = Settings.model_config
    data_dir: Path = Settings.model_fields["data_dir"].default
    image_dir: Path = Settings.model_fields["image_dir"].default_factory()
    database_url: str = Settings.model_fields["database_url"].default


def protected_locations() -> tuple[Path, ...]:
    try:
        locations = StorageLocations()
        url = make_url(locations.database_url)
        if url.get_backend_name() != "sqlite":
            raise ValueError("unsupported database")
        paths = [locations.data_dir.expanduser(), locations.image_dir.expanduser()]
        if url.database and url.database != ":memory:":
            database = Path(url.database).expanduser()
            database = database if database.is_absolute() else BACKEND_DIR / database
            # Protect the directory too: a new report must never become a live
            # SQLite WAL/SHM/journal sidecar when DATABASE_URL is outside data_dir.
            paths.extend((database, database.parent))
        return tuple(path.resolve() for path in paths)
    except (ValueError, OSError) as error:
        raise BenchmarkError(
            "Cannot validate configured storage locations safely."
        ) from error


def check_outside_storage(path: Path, protected: tuple[Path, ...]) -> None:
    resolved = path.resolve()
    if any(resolved == root or root in resolved.parents for root in protected):
        raise BenchmarkError(
            "Benchmark/report location overlaps managed archive state."
        )


def validate_output(path: Path, protected: tuple[Path, ...]) -> Path:
    path = path.expanduser().absolute()
    for candidate in (path, *path.parents):
        if is_link_or_junction(candidate):
            raise BenchmarkError(
                "Report destination must not contain links or junctions."
            )
    check_outside_storage(path, protected)
    if path.exists():
        raise BenchmarkError(
            "Report destination already exists; choose a new filename."
        )
    if not path.parent.is_dir():
        raise BenchmarkError("Report destination parent must already exist.")
    return path


@contextmanager
def disposable_settings(protected: tuple[Path, ...]):
    parent = Path(tempfile.gettempdir()).resolve()
    check_outside_storage(parent, protected)
    with tempfile.TemporaryDirectory(
        prefix="faunavault-catalog-benchmark-", dir=parent
    ) as name:
        root = Path(name).resolve()
        check_outside_storage(root, protected)
        settings = IsolatedSettings(
            _env_file=None,
            data_dir=root / "data",
            image_dir=root / "images",
            database_url=f"sqlite:///{root / 'catalog.db'}",
        )
        for target in (settings.data_dir, settings.image_dir, settings.database_path):
            if target is None or root not in target.resolve().parents:
                raise BenchmarkError(
                    "Benchmark state escaped its owned temporary directory."
                )
        yield settings


def publish_report(path: Path, report: dict, protected: tuple[Path, ...]) -> None:
    path = validate_output(path, protected)
    staging = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=".catalog-report-",
            suffix=".tmp",
            delete=False,
        ) as stream:
            staging = Path(stream.name)
            json.dump(report, stream, indent=2, ensure_ascii=True, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Linking publishes the complete file and refuses a concurrent overwrite.
        validate_output(path, protected)
        os.link(staging, path)
    finally:
        if staging is not None:
            staging.unlink(missing_ok=True)
