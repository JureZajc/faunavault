from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.backup.integrity import BackupError
from app.backup.service import create_backup
from app.backup.verify import VerificationResult, verify_backup
from app.config import get_settings


def _format_size(value: int) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    size = float(value)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{value} B"


def _print_result(result: VerificationResult, label: str) -> None:
    manifest = result.manifest
    print(f"{label}: {result.backup_path}")
    if manifest is not None:
        database = next(
            (entry for entry in manifest.files if entry.role == "database"), None
        )
        if database is not None:
            print(f"Database size: {_format_size(database.size_bytes)}")
        print(f"Payload files: {manifest.counts.payload_files}")
        print(f"Total backup size: {_format_size(result.total_size_bytes)}")
        print(
            "Photos: "
            f"{manifest.counts.photos} total, "
            f"{manifest.counts.active_photos} active, "
            f"{manifest.counts.trashed_photos} Trash"
        )
    for warning in result.warnings:
        print(f"Warning: {warning}")
    for error in result.errors:
        print(f"Error: {error}", file=sys.stderr)
    print("Status: VALID" if result.valid else "Status: INVALID")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="faunavault-backup",
        description="Create and verify cold local FaunaVault backups.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="create a verified cold backup")
    create.add_argument("destination", type=Path, help="existing destination directory")
    verify = commands.add_parser("verify", help="verify an existing backup")
    verify.add_argument("backup_path", type=Path, help="backup directory to verify")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "verify":
        result = verify_backup(args.backup_path)
        _print_result(result, "Backup")
        return 0 if result.valid else 1
    try:
        backup_path, result = create_backup(args.destination, get_settings())
    except (BackupError, OSError, ValueError) as exc:
        print(f"Backup failed: {exc}", file=sys.stderr)
        return 1
    result.backup_path = backup_path
    _print_result(result, "Backup created")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
