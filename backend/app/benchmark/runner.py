from __future__ import annotations

import math
import platform
import sqlite3
import statistics
import subprocess
import sys
from pathlib import Path
from time import perf_counter_ns

from sqlalchemy import event
from sqlmodel import Session

from app.database import create_database_engine
from app.migrations import LATEST_SCHEMA_VERSION
from app.storage_startup import initialize_archive_storage

from .correctness import Oracle, require
from .dataset import DATASET_VERSION, SEED, generate_dataset, populate
from .safety import BenchmarkError, disposable_settings
from .scenarios import build_scenarios

FORMAT_VERSION = 1
WARMUPS = 2
GUIDELINE_MS = 500
CATALOG_ROLES = (
    "filtered_count",
    "items",
    "status_facets",
    "category_facets",
    "active_total",
)
ROLES = {
    "catalog": CATALOG_ROLES,
    "smart": ("saved_definition", *CATALOG_ROLES),
    "detail": ("saved_definition",),
    "map": ("map_points",),
    "timeline": ("month_counts", "unknown_capture_count", "month_previews"),
    "taxa": ("taxa_count", "taxa_items", "selected_taxon"),
}


def statistics_ms(samples_ns: list[int]) -> dict:
    ordered = sorted(value / 1_000_000 for value in samples_ns)
    return {
        "iterations": len(ordered),
        "median_ms": statistics.median(ordered),
        "p95_ms": ordered[math.ceil(0.95 * len(ordered)) - 1]
        if len(ordered) >= 20
        else None,
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
    }


def measure(call, runs: int) -> dict:
    for _ in range(WARMUPS):
        call()
    samples = []
    for _ in range(runs):
        started = perf_counter_ns()
        call()
        samples.append(perf_counter_ns() - started)
    return statistics_ms(samples)


def invoke(engine, scenario, *, page=None):
    with Session(engine) as session:
        return scenario.invoke(session, page=page)


def capture(engine, scenario):
    statements = []
    sql_calls = []

    def orm_execute(state):
        statements.append((state.statement, state.parameters))

    def cursor_execute(_connection, _cursor, statement, parameters, _context, _many):
        sql_calls.append((statement, parameters))

    with Session(engine) as session:
        event.listen(session, "do_orm_execute", orm_execute)
        event.listen(engine, "before_cursor_execute", cursor_execute)
        try:
            response = scenario.invoke(session)
        finally:
            event.remove(engine, "before_cursor_execute", cursor_execute)
            event.remove(session, "do_orm_execute", orm_execute)
    roles = ROLES[scenario.kind]
    if scenario.kind in ("catalog", "smart") and response.total == 0:
        roles = tuple(role for role in roles if role != "items")
    if len(statements) != len(roles) or len(sql_calls) != len(roles):
        raise BenchmarkError(
            f"Unexpected production query shape for {scenario.name}; update profiling roles."
        )
    return response, list(zip(roles, statements, sql_calls, strict=True))


def replay(engine, statement, parameters):
    # These are statement objects emitted by the real service, not rebuilt SQL.
    with Session(engine) as session:
        return session.execute(statement, params=parameters).all()


def profile(engine, calls, runs: int, cache: dict) -> list[dict]:
    components = []
    for role, (statement, orm_parameters), (sql, parameters) in calls:
        key = (sql, repr(parameters))
        if key not in cache:
            with engine.connect() as connection:
                plan = connection.exec_driver_sql(
                    "EXPLAIN QUERY PLAN " + sql, parameters
                ).all()
            details = [row[3] for row in plan]
            rows = replay(engine, statement, orm_parameters)
            cache[key] = {
                "timing": measure(
                    lambda s=statement, p=orm_parameters: replay(engine, s, p), runs
                ),
                "rows_returned": len(rows),
                "sql": sql,
                "parameters": list(parameters),
                "plan": [
                    {"id": row[0], "parent": row[1], "detail": row[3]} for row in plan
                ],
                "plan_summary": {
                    "scans": [detail for detail in details if "SCAN " in detail],
                    "index_usage": [
                        detail
                        for detail in details
                        if "INDEX" in detail or "INTEGER PRIMARY KEY" in detail
                    ],
                    "temporary_btrees": [
                        detail for detail in details if "TEMP B-TREE" in detail
                    ],
                    "joins": [detail for detail in details if "JOIN" in detail],
                    "substring_predicate": " LIKE " in sql,
                },
            }
        components.append({"role": role, **cache[key]})
    return components


def environment() -> dict:
    root = Path(__file__).resolve().parents[3]
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        revision = completed.stdout.strip() if completed.returncode == 0 else None
    except OSError:
        revision = None
    return {
        "python_version": sys.version.split()[0],
        "sqlite_version": sqlite3.sqlite_version,
        "platform": platform.system(),
        "platform_release": platform.release(),
        "machine": platform.machine(),
        "git_revision": revision,
    }


def database_metadata(engine) -> dict:
    with engine.connect() as connection:
        pragmas = {
            name: connection.exec_driver_sql(f"PRAGMA {name}").scalar()
            for name in (
                "foreign_keys",
                "busy_timeout",
                "journal_mode",
                "synchronous",
                "cache_size",
                "page_size",
                "automatic_index",
                "temp_store",
            )
        }
        indexes = connection.exec_driver_sql(
            "SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name"
        ).all()
        versions = (
            connection.exec_driver_sql(
                "SELECT version FROM schema_migration ORDER BY version"
            )
            .scalars()
            .all()
        )
    if versions != list(range(1, LATEST_SCHEMA_VERSION + 1)):
        raise BenchmarkError(
            "Disposable database does not have the current migration history."
        )
    return {
        "schema_version": LATEST_SCHEMA_VERSION,
        "pragmas": pragmas,
        "indexes": [{"name": name, "sql": sql} for name, sql in indexes],
    }


def assess(results: list[dict]) -> dict:
    assessments = {}
    for area in (
        "default catalog browsing",
        "filtered catalog",
        "text search",
        "deep pagination",
        "catalog counts",
        "Smart Collection result queries",
        "Smart Collection live counts",
    ):
        candidates = []
        for result in results:
            if result["area"] == area:
                candidates.append((result["name"], result["timing"]["median_ms"]))
            if area in ("catalog counts", "Smart Collection live counts") and result[
                "kind"
            ] == ("smart" if area.startswith("Smart") else "catalog"):
                for component in result["components"]:
                    if component["role"] == "filtered_count" or (
                        area == "catalog counts"
                        and component["role"]
                        in ("active_total", "status_facets", "category_facets")
                    ):
                        candidates.append(
                            (
                                result["name"] + "/" + component["role"],
                                component["timing"]["median_ms"],
                            )
                        )
        name, maximum = max(candidates, key=lambda item: item[1])
        # A timing over budget alone cannot prove that a small safe fix exists.
        assessments[area] = {
            "classification": "no action needed"
            if maximum <= GUIDELINE_MS
            else "requires a dedicated follow-up",
            "worst_scenario": name,
            "worst_median_ms": maximum,
            "guideline_ms": GUIDELINE_MS,
            "basis": "warm synthetic service/component median; verify costs and plans before choosing a fix",
        }
    return assessments


def benchmark_size(
    size: int, runs: int, protected: tuple[Path, ...], *, progress=print
) -> dict:
    with disposable_settings(protected) as settings:
        engine = create_database_engine(settings)
        try:
            started = perf_counter_ns()
            initialize_archive_storage(engine, settings)
            setup_ns = perf_counter_ns() - started
            started = perf_counter_ns()
            dataset = generate_dataset(size)
            populate(engine, dataset)
            with Session(engine) as session:
                scenarios = build_scenarios(dataset, session)
            generation_ns = perf_counter_ns() - started
            metadata = database_metadata(engine)
            progress(
                f"\n{size:,} photos: validating {len(scenarios)} production scenarios…",
                flush=True,
            )
            started = perf_counter_ns()
            oracle = Oracle(dataset)
            expected_counts = {}
            for scenario in scenarios:
                response = invoke(engine, scenario)
                expected_counts[scenario.name] = oracle.verify(scenario, response)
                if scenario.kind in ("catalog", "smart"):
                    adjacent = invoke(engine, scenario, page=scenario.page + 1)
                    oracle.verify(scenario, adjacent, page=scenario.page + 1)
                    require(
                        not (
                            {item.id for item in response.items}
                            & {item.id for item in adjacent.items}
                        ),
                        scenario,
                        "adjacent page overlap",
                    )
                    if scenario.equivalent:
                        equivalent = next(
                            item
                            for item in scenarios
                            if item.name == scenario.equivalent
                        )
                        require(
                            response.model_dump()
                            == invoke(engine, equivalent).model_dump(),
                            scenario,
                            "Smart Collection/catalog semantic parity",
                        )
            validation_ns = perf_counter_ns() - started
            results = []
            cache = {}
            profiling_ns = 0
            execution_ns = 0
            for index, scenario in enumerate(scenarios, 1):
                progress(f"  [{index}/{len(scenarios)}] {scenario.name}", flush=True)
                started = perf_counter_ns()
                response, calls = capture(engine, scenario)
                oracle.verify(scenario, response)
                components = profile(engine, calls, runs, cache)
                profiling_ns += perf_counter_ns() - started
                started = perf_counter_ns()
                timing = measure(lambda item=scenario: invoke(engine, item), runs)
                execution_ns += perf_counter_ns() - started
                results.append(
                    {
                        "name": scenario.name,
                        "area": scenario.area,
                        "kind": scenario.kind,
                        "criteria": scenario.query.model_dump(mode="json")
                        if scenario.kind in ("catalog", "smart")
                        else None,
                        "page": scenario.page
                        if scenario.kind in ("catalog", "smart")
                        else None,
                        "page_size": 48
                        if scenario.kind in ("catalog", "smart")
                        else None,
                        "offset": (scenario.page - 1) * 48
                        if scenario.kind in ("catalog", "smart")
                        else None,
                        "result_count": expected_counts[scenario.name],
                        "equivalent_catalog": scenario.equivalent,
                        "timing": timing,
                        "components": components,
                    }
                )
            by_name = {item["name"]: item for item in results}
            comparisons = []
            for result in results:
                if result["equivalent_catalog"]:
                    normal = by_name[result["equivalent_catalog"]]
                    delta = (
                        result["timing"]["median_ms"] - normal["timing"]["median_ms"]
                    )
                    comparisons.append(
                        {
                            "smart": result["name"],
                            "catalog": normal["name"],
                            "median_delta_ms": delta,
                            "median_ratio": result["timing"]["median_ms"]
                            / normal["timing"]["median_ms"],
                            "explanation": "Smart page adds saved-definition lookup/validation; shared SQL and live count are identical. Sequential-run variation is not proof of an overhead regression.",
                        }
                    )
            return {
                "dataset_size": size,
                "distributions": dataset.distributions(),
                "database": metadata,
                "phases_ms": {
                    "storage_schema_setup": setup_ns / 1e6,
                    "generation_insertion": generation_ns / 1e6,
                    "correctness_validation": validation_ns / 1e6,
                    "diagnostic_profiling": profiling_ns / 1e6,
                    "benchmark_execution": execution_ns / 1e6,
                },
                "scenarios": results,
                "smart_comparisons": comparisons,
                "assessments": assess(results),
            }
        finally:
            engine.dispose()


def run_benchmarks(
    sizes: list[int], runs: int, protected: tuple[Path, ...], *, progress=print
) -> dict:
    if not sizes or any(size < 1 for size in sizes) or runs < 1:
        raise ValueError("sizes and runs must be positive")
    return {
        "format_version": FORMAT_VERSION,
        "dataset_version": DATASET_VERSION,
        "seed": SEED,
        "environment": environment(),
        "methodology": {
            "cache": "warm",
            "warmups": WARMUPS,
            "runs": runs,
            "timer": "perf_counter_ns",
            "p95": "nearest-rank, reported only with >=20 iterations",
            "service_scope": "fresh-session production service invocation, result consumption and response models; excludes HTTP, JSON encoding, rendering and images",
            "component_scope": "captured production statements replayed in fresh sessions with full consumption; duplicate SQL/parameters measured once per dataset",
            "guideline_ms": GUIDELINE_MS,
            "production_changes": False,
            "experimental_fts": False,
        },
        "datasets": [
            benchmark_size(size, runs, protected, progress=progress) for size in sizes
        ],
    }


def print_report(report: dict, *, verbose: bool = False) -> None:
    print("\nWarm-cache results (milliseconds; fresh-session production services)")
    for dataset in report["datasets"]:
        print(
            f"\n{dataset['dataset_size']:,} Photos ({dataset['distributions']['active']:,} active)"
        )
        print(
            f"{'Scenario':42} {'Matches':>8} {'Median':>10} {'p95':>10} {'Min':>10} {'Max':>10}"
        )
        for result in dataset["scenarios"]:
            timing = result["timing"]
            tail = f"{timing['p95_ms']:.2f}" if timing["p95_ms"] is not None else "—"
            print(
                f"{result['name']:42} {result['result_count']:8} {timing['median_ms']:10.2f} {tail:>10} {timing['min_ms']:10.2f} {timing['max_ms']:10.2f}"
            )
            if verbose:
                for component in result["components"]:
                    print(
                        f"  {component['role']}: {component['timing']['median_ms']:.2f} ms\n    {component['sql']}\n    parameters={component['parameters']}\n    {component['plan']}"
                    )
        print("Plan summary:")
        unique = set()
        for result in dataset["scenarios"]:
            for component in result["components"]:
                summary = component["plan_summary"]
                description = (
                    component["role"],
                    tuple(summary["scans"]),
                    tuple(summary["index_usage"]),
                    tuple(summary["temporary_btrees"]),
                    summary["substring_predicate"],
                )
                if description not in unique:
                    unique.add(description)
                    print(
                        f"  {result['name']}/{component['role']}: "
                        + "; ".join(row["detail"] for row in component["plan"])
                    )
        for area, assessment in dataset["assessments"].items():
            print(
                f"  {area}: {assessment['classification']} ({assessment['worst_median_ms']:.2f} ms, {assessment['worst_scenario']})"
            )
    print(
        "\nAssessments use a 500 ms median reporting guideline, never a CI threshold. Component timings are diagnostic and are not additive service totals. Smart live counts arrive with page responses. See JSON/--verbose for components and raw plans."
    )
