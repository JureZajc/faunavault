"""Read-only setup checks composed by the existing maintenance doctor."""

from __future__ import annotations

import os
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx

from app.archive_integrity import contains_link_or_junction, open_read_only_database
from app.config import Settings
from app.migrations import LATEST_SCHEMA_VERSION
from app.storage_startup import validate_storage_selection
from app.version import APP_VERSION


@dataclass(frozen=True)
class Diagnostic:
    status: Literal["PASS", "WARNING", "FAIL", "OPTIONAL"]
    code: str
    message: str


def _directory_check(label: str, directory: Path) -> Diagnostic:
    directory = directory.absolute()
    if contains_link_or_junction(directory):
        return Diagnostic("FAIL", label, "Storage must not contain links or junctions.")
    nearest = directory
    while not nearest.exists() and nearest != nearest.parent:
        nearest = nearest.parent
    if not nearest.is_dir():
        return Diagnostic("FAIL", label, f"Not a directory: {nearest}")
    if not os.access(nearest, os.R_OK | os.W_OK | os.X_OK):
        return Diagnostic("FAIL", label, f"Directory is not accessible: {nearest}")
    if not directory.is_dir():
        return Diagnostic("OPTIONAL", label, f"Created by backend startup: {directory}")
    return Diagnostic("PASS", label, f"Accessible: {directory}")


def environment_diagnostics(
    settings: Settings,
    *,
    ollama: bool = False,
    transport: httpx.BaseTransport | None = None,
) -> list[Diagnostic]:
    findings = [
        Diagnostic("PASS", "version", APP_VERSION),
        Diagnostic(
            "PASS" if sys.version_info >= (3, 12) else "FAIL",
            "backend_python",
            f"Python {sys.version.split()[0]}; requires 3.12+.",
        ),
    ]
    database = settings.database_path
    if database is None:
        findings.append(
            Diagnostic("FAIL", "database", "Configure a file-backed SQLite archive.")
        )
    else:
        findings.append(Diagnostic("PASS", "database_location", str(database)))
        try:
            validate_storage_selection(settings)
        except (ValueError, OSError, sqlite3.Error) as error:
            findings.append(Diagnostic("FAIL", "storage_selection", str(error)))
        if database.exists():
            try:
                if contains_link_or_junction(database) or not database.is_file():
                    raise ValueError("Database must be a regular local file.")
                connection = open_read_only_database(database)
                try:
                    versions = [
                        row[0]
                        for row in connection.execute(
                            "SELECT version FROM schema_migration ORDER BY version"
                        )
                    ]
                finally:
                    connection.close()
                latest = versions[-1] if versions else 0
                if (
                    versions != list(range(1, latest + 1))
                    or latest > LATEST_SCHEMA_VERSION
                ):
                    findings.append(
                        Diagnostic("FAIL", "schema", "Unsupported migration history.")
                    )
                elif latest < LATEST_SCHEMA_VERSION:
                    findings.append(
                        Diagnostic(
                            "WARNING",
                            "schema",
                            f"Schema {latest}; startup will migrate to {LATEST_SCHEMA_VERSION}. "
                            "Create a supported cold backup before upgrading an existing archive.",
                        )
                    )
                else:
                    findings.append(Diagnostic("PASS", "schema", f"Schema {latest}."))
            except sqlite3.OperationalError as error:
                # Pre-versioned archives are valid upgrade inputs, not fresh archives.
                if "no such table: schema_migration" in str(error):
                    findings.append(
                        Diagnostic(
                            "WARNING",
                            "schema",
                            "Legacy unversioned database; startup applies migrations. "
                            "Preserve its database and image root before upgrading.",
                        )
                    )
                else:
                    findings.append(Diagnostic("FAIL", "database", str(error)))
            except (sqlite3.Error, ValueError, OSError) as error:
                findings.append(Diagnostic("FAIL", "database", str(error)))
        else:
            findings.append(
                Diagnostic(
                    "OPTIONAL",
                    "database",
                    "Empty archive: backend startup creates the database and migrations.",
                )
            )
        findings.append(_directory_check("database_directory", database.parent))
    for role, directory in {
        **settings.image_dirs,
        "staging": settings.staging_dir,
        "purge": settings.purge_dir,
    }.items():
        findings.append(_directory_check(role, directory))
    findings.append(
        Diagnostic(
            "WARNING",
            "permissions",
            "Access checks are advisory; startup performs the actual writes.",
        )
    )
    if not ollama:
        findings.append(
            Diagnostic(
                "OPTIONAL",
                "ollama",
                "Not probed. Use --ollama to check local AI availability.",
            )
        )
    else:
        try:
            with httpx.Client(
                timeout=httpx.Timeout(5, connect=2), transport=transport
            ) as client:
                response = client.get(
                    settings.ollama_base_url.rstrip("/") + "/api/tags"
                )
                response.raise_for_status()
                models = response.json()["models"]
                if not isinstance(models, list):
                    raise ValueError("Invalid model list")
                available = {
                    model.get("name", model.get("model"))
                    for model in models
                    if isinstance(model, dict)
                }
            findings.append(Diagnostic("PASS", "ollama", "Service responded."))
            for model in dict.fromkeys(
                (settings.ai_primary_model, settings.ai_fallback_model)
            ):
                found = model in available or (
                    ":" not in model and model + ":latest" in available
                )
                findings.append(
                    Diagnostic(
                        "PASS" if found else "WARNING",
                        "ollama_model",
                        f"{model}: {'available' if found else 'not installed; install explicitly to classify'}.",
                    )
                )
        except (
            httpx.HTTPError,
            httpx.InvalidURL,
            ValueError,
            KeyError,
            TypeError,
        ) as error:
            findings.append(
                Diagnostic(
                    "OPTIONAL",
                    "ollama",
                    f"AI unavailable ({type(error).__name__}); core archive remains usable.",
                )
            )
    return findings
