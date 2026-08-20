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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="faunavault-maintenance",
        description="Inspect and safely repair a stopped FaunaVault live archive.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor", help="inspect the configured live archive read-only")
    repair = commands.add_parser(
        "repair-derived",
        help="inspect or rebuild invalid resized and thumbnail derivatives",
    )
    repair.add_argument(
        "--apply",
        action="store_true",
        help="perform atomic repairs (default: dry run)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        settings = get_settings()
        if args.command == "doctor":
            result = doctor(settings, progress=_progress)
            _print_health(result)
            return 0 if result.status == "HEALTHY" else 1
        result = repair_derived(settings, apply=args.apply, progress=_progress)
        _print_repair(result)
        return 0 if result.health.status == "HEALTHY" and result.failed == 0 else 1
    except (MaintenanceSetupError, ValueError, OSError) as exc:
        print(f"Maintenance could not start: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
