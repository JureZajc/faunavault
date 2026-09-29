from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.benchmark.runner import print_report, run_benchmarks
from app.benchmark.safety import (
    BenchmarkError,
    protected_locations,
    publish_report,
    validate_output,
)


def positive_int(value: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if result < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Warm-cache production query benchmark on isolated synthetic state only."
    )
    parser.add_argument(
        "--sizes", nargs="+", type=positive_int, default=[1000, 10000, 50000, 100000]
    )
    parser.add_argument("--runs", type=positive_int, default=10)
    parser.add_argument(
        "--output",
        type=Path,
        help="Publish JSON to a new file outside managed archive storage.",
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        protected = protected_locations()
        output = (
            validate_output(arguments.output, protected)
            if arguments.output is not None
            else None
        )
        report = run_benchmarks(arguments.sizes, arguments.runs, protected)
        if output is not None:
            publish_report(output, report, protected)
        print_report(report, verbose=arguments.verbose)
        return 0
    except KeyboardInterrupt:
        print("Benchmark interrupted; disposable state cleaned up.", file=sys.stderr)
        return 130
    except (BenchmarkError, OSError) as error:
        print(f"Benchmark failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
