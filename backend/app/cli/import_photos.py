from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
from collections.abc import AsyncIterator, Iterator
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException
from sqlmodel import Session

from app.archive_integrity import (
    ArchiveIntegrityError,
    is_link_or_junction,
    open_read_only_database,
    validate_database_connection,
)
from app.config import Settings, get_settings
from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION
from app.services.image_variants import source_format_for_filename
from app.services.perceptual_duplicates import VisualDuplicateIndex, VisualIndexEntry
from app.services.photo_lifecycle import create_photo_from_source, inspect_local_photo

CHUNK_SIZE = 1024 * 1024
PROGRESS_INTERVAL = 100


class ImportSetupError(RuntimeError):
    """The requested source or configured archive cannot be used safely."""


@dataclass(frozen=True)
class ScanFailure:
    path: Path
    reason: str


@dataclass
class ImportSummary:
    scanned: int = 0
    imported: int = 0
    duplicates: int = 0
    visual_duplicates: int = 0
    unsupported: int = 0
    failed: int = 0
    jobs: int = 0


def _contained(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_source(source: Path, settings: Settings) -> Path:
    if is_link_or_junction(source):
        raise ImportSetupError("Source directory must not be a link or junction")
    try:
        root = source.expanduser().resolve(strict=True)
    except OSError as exc:
        raise ImportSetupError(f"Source directory does not exist: {source}") from exc
    if not root.is_dir():
        raise ImportSetupError(f"Source is not a directory: {source}")
    image_root = settings.image_dir.resolve()
    if _contained(root, image_root) or _contained(image_root, root):
        raise ImportSetupError("Source directory overlaps managed image storage")
    return root


def _read_archive(settings: Settings) -> sqlite3.Connection:
    path = settings.database_path
    if path is None or not path.is_file():
        raise ImportSetupError(
            "Configured SQLite archive does not exist; start the backend once first"
        )
    try:
        connection = open_read_only_database(path)
        try:
            validate_database_connection(connection, LATEST_SCHEMA_VERSION)
        except Exception:
            connection.close()
            raise
        return connection
    except (ArchiveIntegrityError, sqlite3.Error) as exc:
        raise ImportSetupError(f"Configured archive is not ready: {exc}") from exc


def _visual_index(connection: sqlite3.Connection) -> VisualDuplicateIndex:
    index = VisualDuplicateIndex()
    rows = connection.execute(
        "SELECT id, perceptual_hash, original_filename, display_title, "
        "common_name, species_guess, deleted_at FROM photo "
        "WHERE perceptual_hash IS NOT NULL ORDER BY id"
    )
    for row in rows:
        index.add(
            VisualIndexEntry(
                photo_id=int(row[0]),
                perceptual_hash=str(row[1]),
                original_filename=str(row[2]),
                display_title=row[3],
                common_name=row[4],
                species_guess=row[5],
                location="trash" if row[6] is not None else "catalog",
            )
        )
    return index


def _walk(root: Path, recursive: bool) -> Iterator[Path | ScanFailure]:
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            with os.scandir(directory) as scan:
                entries = sorted(
                    scan,
                    key=lambda entry: (entry.name.casefold(), entry.name),
                )
        except OSError as exc:
            yield ScanFailure(directory, str(exc))
            continue
        children: list[Path] = []
        for entry in entries:
            path = Path(entry.path)
            try:
                if is_link_or_junction(path):
                    yield path
                elif entry.is_dir(follow_symlinks=False):
                    if recursive:
                        children.append(path)
                else:
                    yield path
            except OSError as exc:
                yield ScanFailure(path, str(exc))
        stack.extend(reversed(children))


async def _local_chunks(path: Path) -> AsyncIterator[bytes]:
    with path.open("rb") as source:
        while chunk := source.read(CHUNK_SIZE):
            yield chunk


def _reason(error: HTTPException) -> str:
    detail = error.detail
    if isinstance(detail, dict):
        return str(detail.get("message") or detail.get("code") or detail)
    return str(detail)


def _report(state: str, path: Path, reason: str = "", *, verbose: bool) -> None:
    if verbose or state not in {"imported", "would import", "unsupported"}:
        suffix = f" — {reason}" if reason else ""
        print(f"{state}: {path}{suffix}")


async def import_folder(
    source: Path,
    settings: Settings,
    *,
    recursive: bool = False,
    dry_run: bool = False,
    allow_visual_duplicates: bool = False,
    classify: bool = False,
    verbose: bool = False,
) -> ImportSummary:
    root = _validate_source(source, settings)
    summary = ImportSummary()
    planned_digests: dict[str, str] = {}
    with closing(_read_archive(settings)) as reader:
        index = _visual_index(reader)
        engine = None if dry_run else create_database_engine(settings)
        try:
            for item in _walk(root, recursive):
                if isinstance(item, ScanFailure):
                    summary.failed += 1
                    _report("failed", item.path, item.reason, verbose=verbose)
                    continue
                path = item
                summary.scanned += 1
                if summary.scanned % PROGRESS_INTERVAL == 0 and not verbose:
                    print(f"Scanned {summary.scanned} files...", file=sys.stderr)
                if (
                    is_link_or_junction(path)
                    or not path.is_file()
                    or source_format_for_filename(path.name) is None
                ):
                    summary.unsupported += 1
                    _report("unsupported", path, verbose=verbose)
                    continue
                try:
                    if dry_run:
                        inspection = inspect_local_photo(path, settings)
                        previous = planned_digests.get(inspection.digest)
                        existing = reader.execute(
                            "SELECT id, deleted_at FROM photo WHERE content_sha256 = ? LIMIT 1",
                            (inspection.digest,),
                        ).fetchone()
                        if previous is not None or existing is not None:
                            summary.duplicates += 1
                            label = previous or f"photo {existing[0]}"
                            _report("duplicate", path, label, verbose=verbose)
                            continue
                        matches = index.find(inspection.perceptual_hash)
                        if matches and not allow_visual_duplicates:
                            summary.visual_duplicates += 1
                            match = matches[0]
                            label = (
                                f"photo {match.photo_id}"
                                if match.photo_id > 0
                                else match.original_filename
                            )
                            _report(
                                "possible visual duplicate",
                                path,
                                label,
                                verbose=verbose,
                            )
                            continue
                        planned_digests[inspection.digest] = str(path)
                        index.add(
                            VisualIndexEntry(
                                photo_id=-summary.scanned,
                                perceptual_hash=inspection.perceptual_hash,
                                original_filename=str(path),
                            )
                        )
                        summary.imported += 1
                        summary.jobs += int(classify)
                        _report("would import", path, verbose=verbose)
                    else:
                        policy = source_format_for_filename(path.name)
                        assert policy is not None
                        assert engine is not None
                        with Session(engine) as session:
                            photo = await create_photo_from_source(
                                session,
                                _local_chunks(path),
                                path.name,
                                policy.source.media_type,
                                settings,
                                allow_visual_duplicate=allow_visual_duplicates,
                                classify=classify,
                                visual_lookup=lambda _session, value: index.find(value),
                            )
                        index.add(
                            VisualIndexEntry(
                                photo_id=int(photo.id),
                                perceptual_hash=str(photo.perceptual_hash),
                                original_filename=photo.original_filename,
                            )
                        )
                        summary.imported += 1
                        summary.jobs += int(classify)
                        _report("imported", path, verbose=verbose)
                except HTTPException as exc:
                    detail = exc.detail if isinstance(exc.detail, dict) else {}
                    code = detail.get("code")
                    if code == "duplicate_photo":
                        summary.duplicates += 1
                        _report("duplicate", path, _reason(exc), verbose=verbose)
                    elif code == "possible_visual_duplicate":
                        summary.visual_duplicates += 1
                        _report(
                            "possible visual duplicate",
                            path,
                            _reason(exc),
                            verbose=verbose,
                        )
                    else:
                        summary.failed += 1
                        _report("failed", path, _reason(exc), verbose=verbose)
                except Exception as exc:
                    summary.failed += 1
                    _report("failed", path, str(exc), verbose=verbose)
        finally:
            if engine is not None:
                engine.dispose()
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="faunavault-import",
        description="Copy photos from a local folder into an initialized FaunaVault archive.",
    )
    parser.add_argument("source", type=Path, help="source directory (never modified)")
    parser.add_argument(
        "--recursive", action="store_true", help="include nested directories"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="inspect without changes"
    )
    parser.add_argument(
        "--allow-visual-duplicates",
        action="store_true",
        help="keep photos flagged as possible visual duplicates",
    )
    parser.add_argument(
        "--classify", action="store_true", help="queue classification for new photos"
    )
    parser.add_argument("--verbose", action="store_true", help="show every file result")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        summary = asyncio.run(
            import_folder(
                args.source,
                get_settings(),
                recursive=args.recursive,
                dry_run=args.dry_run,
                allow_visual_duplicates=args.allow_visual_duplicates,
                classify=args.classify,
                verbose=args.verbose,
            )
        )
    except (ImportSetupError, OSError, ValueError) as exc:
        print(f"Import could not start: {exc}", file=sys.stderr)
        return 2
    print("Dry run complete" if args.dry_run else "Import complete")
    for label, value in (
        ("Scanned", summary.scanned),
        ("Would import" if args.dry_run else "Imported", summary.imported),
        ("Duplicates", summary.duplicates),
        ("Possible visual duplicates", summary.visual_duplicates),
        ("Unsupported", summary.unsupported),
        ("Failed", summary.failed),
        ("Jobs planned" if args.dry_run else "Jobs queued", summary.jobs),
    ):
        print(f"{label}: {value}")
    return 1 if summary.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
