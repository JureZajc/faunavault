from __future__ import annotations

import argparse
import sys

from app.config import get_settings
from app.services.archive_maintenance import (
    Finding,
    HealthResult,
    MaintenanceSetupError,
    RepairResult,
    doctor,
    repair_derived,
)
from app.services.duplicate_scan import MAX_PAIRS, MAX_PROBES, scan_duplicates
from app.services.environment_diagnostics import environment_diagnostics
from app.services.photo_metadata_backfill import (
    MetadataBackfillResult,
    MetadataBackfillSetupError,
    backfill_photo_metadata,
)

ORPHAN_EXAMPLE_LIMIT = 10
ORPHAN_CODES = {"orphan_file", "orphan_directory", "maintenance_temp"}


def _progress(processed: int, total: int) -> None:
    print(f"Progress: {processed}/{total} photos", file=sys.stderr)


def _format_finding(finding: Finding) -> str:
    fields = [finding.severity.upper(), finding.code]
    if finding.photo_id is not None:
        fields.append(f"photo={finding.photo_id}")
    if finding.role is not None:
        fields.append(f"role={finding.role}")
    if finding.filename is not None:
        fields.append(f"file={finding.filename}")
    fields.append(finding.message)
    return " ".join(fields)


def _print_health(result: HealthResult) -> None:
    orphan_examples: dict[str, int] = {}
    for finding in result.findings:
        if finding.code in ORPHAN_CODES:
            role = finding.role or "unknown"
            count = orphan_examples.get(role, 0)
            if count >= ORPHAN_EXAMPLE_LIMIT:
                continue
            orphan_examples[role] = count + 1
        stream = sys.stderr if finding.severity == "error" else sys.stdout
        print(_format_finding(finding), file=stream)

    inventory = result.inventory
    print(f"Database: {'OK' if inventory is not None else 'INVALID'}")
    if inventory is not None:
        print(
            f"Photos: {len(inventory.photos)} total, "
            f"{inventory.active_photos} active, {inventory.trashed_photos} Trash"
        )
        print(
            "Classification jobs: "
            + ", ".join(
                f"{status}={inventory.job_counts[status]}"
                for status in ("queued", "running", "succeeded", "failed")
            )
        )
    print(
        "Originals: "
        f"{result.healthy_counts['original']} healthy; "
        f"Resized: {result.healthy_counts['resized']} healthy; "
        f"Thumbnails: {result.healthy_counts['thumbs']} healthy"
    )
    print(
        "Findings: "
        f"{len(result.errors)} errors, {len(result.repairs)} repairable, "
        f"{len(result.warnings)} warnings"
    )
    print(
        "Orphans: "
        + ", ".join(
            f"{role}={result.orphan_counts[role]}"
            for role in ("original", "resized", "thumbs")
        )
    )
    print(f"Status: {result.status}")


def _print_repair(result: RepairResult) -> None:
    _print_health(result.health)
    mode = "APPLY" if result.applied else "DRY RUN"
    print(
        f"Repair {mode}: {result.repaired} repaired, "
        f"{result.skipped_healthy} skipped healthy, {result.failed} failed"
    )
    if not result.applied and result.health.candidates:
        print("No files were changed. Re-run with --apply to perform these repairs.")


def _print_metadata_backfill(result: MetadataBackfillResult) -> None:
    for error in result.errors:
        print(
            f"ERROR photo={error.photo_id} {error.message}",
            file=sys.stderr,
        )
    mode = "APPLY" if result.applied else "DRY RUN"
    updated_label = "updated" if result.applied else "would update"
    print(
        f"Metadata backfill {mode}: {result.processed} processed, "
        f"{result.updated} {updated_label}, {result.skipped} skipped, "
        f"{len(result.errors)} errors"
    )
    if not result.applied and result.updated:
        print("No metadata was changed. Re-run with --apply to save these values.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="faunavault-maintenance",
        description="Inspect and safely repair a stopped FaunaVault live archive.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    duplicates = commands.add_parser(
        "duplicates-scan",
        help="Discover visual pairs from stored fingerprints; stop backend/importer first",
    )
    duplicates.add_argument(
        "--apply", action="store_true", help="persist candidates (default: dry run)"
    )
    duplicates.add_argument("--max-probes", type=int, default=MAX_PROBES)
    duplicates.add_argument("--max-pairs", type=int, default=MAX_PAIRS)
    inspect = commands.add_parser(
        "doctor", help="inspect the configured live archive read-only"
    )
    inspect.add_argument(
        "--environment-only",
        action="store_true",
        help="check setup without scanning or changing the archive",
    )
    inspect.add_argument(
        "--ollama",
        action="store_true",
        help="explicitly probe optional Ollama and models (environment-only)",
    )
    repair = commands.add_parser(
        "repair-derived",
        help="inspect or rebuild invalid resized and thumbnail derivatives",
    )
    repair.add_argument(
        "--apply",
        action="store_true",
        help="perform atomic repairs (default: dry run)",
    )
    metadata = commands.add_parser(
        "backfill-photo-metadata",
        help="inspect or populate missing capture metadata from original photos",
    )
    metadata.add_argument(
        "--apply",
        action="store_true",
        help="write missing metadata (default: dry run)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "doctor" and args.ollama and not args.environment_only:
        print("--ollama requires --environment-only.", file=sys.stderr)
        return 2
    try:
        settings = get_settings()
        if args.command == "duplicates-scan":
            result = scan_duplicates(
                settings,
                apply=args.apply,
                max_probes=args.max_probes,
                max_pairs=args.max_pairs,
                progress=_progress,
                exact_collision=lambda ids: print(
                    "ERROR exact-original SHA collision: photos "
                    + ", ".join(map(str, ids))
                ),
            )
            print(
                f"Duplicate scan {'APPLY' if result.applied else 'DRY RUN'}: {result.processed} photos, {result.skipped} unassessed, {result.pairs} pairs, {result.probes} probes, {result.seconds:.2f}s"
            )
            print(
                "Complete for valid stored fingerprints"
                if result.complete
                else f"INCOMPLETE: {result.reason}"
            )
            return 0 if result.complete and not result.exact_groups else 1
        if args.command == "doctor":
            if args.environment_only:
                findings = environment_diagnostics(settings, ollama=args.ollama)
                for finding in findings:
                    print(f"{finding.status} {finding.code}: {finding.message}")
                return 1 if any(item.status == "FAIL" for item in findings) else 0
            result = doctor(settings, progress=_progress)
            _print_health(result)
            return 0 if result.status == "HEALTHY" else 1
        if args.command == "repair-derived":
            result = repair_derived(settings, apply=args.apply, progress=_progress)
            _print_repair(result)
            return 0 if result.health.status == "HEALTHY" and result.failed == 0 else 1
        backfill = backfill_photo_metadata(settings, apply=args.apply)
        _print_metadata_backfill(backfill)
        return 0 if not backfill.errors else 1
    except (
        MaintenanceSetupError,
        MetadataBackfillSetupError,
        ValueError,
        OSError,
    ) as exc:
        label = (
            "FAIL configuration"
            if args.command == "doctor" and args.environment_only
            else "Maintenance could not start"
        )
        print(f"{label}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
