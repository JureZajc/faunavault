from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.archive_export.schema import EXPORT_FORMAT_VERSION
from app.archive_export.service import (
    ArchiveExportIntegrityError,
    ArchiveExportSetupError,
    ExportResult,
    create_metadata_export,
)
from app.config import get_settings


def _format_size(value: int) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    size = float(value)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{value} B"


def _progress(processed: int, total: int) -> None:
    print(f"Inventorying originals: {processed} / {total}", file=sys.stderr)


def _print_result(result: ExportResult) -> None:
    counts = result.document.counts
    print("Metadata export: COMPLETE")
    print(f"Format: v{EXPORT_FORMAT_VERSION}")
    print(f"Database schema: {result.document.source_database_schema_version}")
    print(
        f"Photos: {counts.photos} total / {counts.active_photos} active / "
        f"{counts.trashed_photos} Trash"
    )
    print(f"Animals: {counts.animals}")
    print(f"Taxa: {counts.taxa}")
    print(f"Original bytes inventoried: {_format_size(counts.original_bytes)}")
    if result.missing_stored_identity_photos:
        print(
            "Warning: "
            f"{result.missing_stored_identity_photos} photo(s) lacked a stored "
            "original size or SHA-256; verified actual values were exported."
        )
    print(f"JSON: {result.json_path}")
    if result.csv_path is not None:
        print(f"CSV: {result.csv_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="faunavault-export",
        description=(
            "Export deterministic, portable FaunaVault metadata and verified "
            "original-file inventory. This is not a backup or restore format."
        ),
    )
    parser.add_argument(
        "destination",
        type=Path,
        help="new export directory (its parent must already exist)",
    )
    parser.add_argument(
        "--csv",
        action="store_true",
        help="also write the flattened optional photos.csv",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = get_settings()
        result = create_metadata_export(
            args.destination,
            settings,
            include_csv=args.csv,
            progress=_progress,
        )
    except ArchiveExportIntegrityError as exc:
        print("Metadata export: FAILED", file=sys.stderr)
        print(f"Error: {exc}", file=sys.stderr)
        print(
            "Run 'faunavault-maintenance doctor' to inspect the live archive.",
            file=sys.stderr,
        )
        return 1
    except (ArchiveExportSetupError, OSError, ValueError) as exc:
        print(f"Metadata export could not start: {exc}", file=sys.stderr)
        return 2
    _print_result(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
