from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from app.benchmark import runner, safety
from app.benchmark.correctness import Oracle
from app.benchmark.dataset import generate_dataset, populate
from app.benchmark.scenarios import Scenario, build_scenarios
from app.catalog_query import CatalogSavedQuery
from app.cli import benchmark_catalog
from app.database import create_database_engine
from app.models import Animal, Photo, SmartCollection, Taxon
from app.services import catalog, smart_collections
from app.storage_startup import initialize_archive_storage


@pytest.fixture(autouse=True)
def local_temp(tmp_path, monkeypatch):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))


@pytest.fixture
def archive():
    with safety.disposable_settings(()) as settings:
        engine = create_database_engine(settings)
        try:
            initialize_archive_storage(engine, settings)
            dataset = generate_dataset(120)
            populate(engine, dataset)
            yield engine, dataset, settings
        finally:
            engine.dispose()


def test_generation_is_deterministic_and_prefix_stable():
    small = generate_dataset(120)
    same = generate_dataset(120)
    larger = generate_dataset(200)
    assert small == same
    assert small.photos == larger.photos[:120]
    assert len(small.photos) == 120
    assert small.distributions()["trash"] == 6
    assert small.distributions()["without_animal"] > 0
    assert small.distributions()["unlinked_taxonomy"] > 0
    assert small.distributions()["linked_taxonomy"] > 0
    assert small.distributions()["missing_capture"] > 0
    assert small.distributions()["with_gps"] > 0
    for photo in small.photos:
        assert (photo["latitude"] is None) == (photo["longitude"] is None)
        assert (
            photo["captured_at"] is not None
            or photo["captured_at_offset_minutes"] is None
        )
        animal = small.animals.get(photo["animal_id"])
        if animal and animal["taxon_id"]:
            assert (
                photo["species_guess"]
                == small.taxa[animal["taxon_id"]]["scientific_name"]
            )


def test_requested_rows_relationships_and_migrated_indexes(archive):
    engine, dataset, settings = archive
    with Session(engine) as session:
        assert len(session.exec(select(Photo)).all()) == 120
        assert len(session.exec(select(Animal)).all()) == len(dataset.animals)
        assert len(session.exec(select(Taxon)).all()) == 8
    metadata = runner.database_metadata(engine)
    assert metadata["schema_version"] == 18
    assert metadata["pragmas"]["foreign_keys"] == 1
    names = {index["name"] for index in metadata["indexes"]}
    assert {
        "ix_photo_catalog_active_created",
        "ix_photo_catalog_active_category_created",
        "ix_photo_catalog_active_status_created",
        "ix_photo_catalog_active_captured",
        "ix_animal_taxon_id",
    } <= names
    assert not any(path.is_file() for path in settings.image_dir.rglob("*"))


def test_all_scenarios_and_smart_parity_use_production_services(archive, monkeypatch):
    engine, dataset, _ = archive
    catalog_calls = []
    smart_calls = []
    original_catalog = catalog.list_catalog_photos
    original_smart = smart_collections.list_smart_collection_photos

    def catalog_spy(*args, **kwargs):
        catalog_calls.append(kwargs)
        return original_catalog(*args, **kwargs)

    def smart_spy(*args, **kwargs):
        smart_calls.append(kwargs)
        return original_smart(*args, **kwargs)

    monkeypatch.setattr(catalog, "list_catalog_photos", catalog_spy)
    monkeypatch.setattr(smart_collections, "list_catalog_photos", catalog_spy)
    monkeypatch.setattr(smart_collections, "list_smart_collection_photos", smart_spy)
    with Session(engine) as session:
        scenarios = build_scenarios(dataset, session)
    oracle = Oracle(dataset)
    for scenario in scenarios:
        response = runner.invoke(engine, scenario)
        oracle.verify(scenario, response)
        if scenario.kind in ("catalog", "smart"):
            next_page = runner.invoke(engine, scenario, page=scenario.page + 1)
            oracle.verify(scenario, next_page, page=scenario.page + 1)
            assert not {item.id for item in response.items} & {
                item.id for item in next_page.items
            }
        if scenario.equivalent:
            normal = next(
                item for item in scenarios if item.name == scenario.equivalent
            )
            assert response.model_dump() == runner.invoke(engine, normal).model_dump()
    assert len(scenarios) == 67
    assert catalog_calls and len(smart_calls) == 10
    expected = {
        "search_none": 0,
        "search_trash_only": 0,
        "search_literal_percent": 1,
        "search_literal_underscore": 1,
        "search_literal_backslash": 1,
    }
    for name, count in expected.items():
        assert (
            len(oracle.matches(next(item for item in scenarios if item.name == name)))
            == count
        )


def test_live_smart_results_change_after_metadata_and_trash(archive):
    engine, dataset, _ = archive
    with Session(engine) as session:
        scenarios = build_scenarios(dataset, session)
    scenario = next(item for item in scenarios if item.name == "smart_category")
    total = runner.invoke(engine, scenario).total
    with Session(engine) as session:
        row = session.get(Photo, 1)
        row.deleted_at = row.created_at
        session.commit()
    assert runner.invoke(engine, scenario).total == total - 1
    with Session(engine) as session:
        row = session.get(Photo, 1)
        row.deleted_at = None
        row.category = "bird"
        session.commit()
    assert runner.invoke(engine, scenario).total == total - 1
    with Session(engine) as session:
        row = session.get(Photo, 1)
        row.category = "mammal"
        session.commit()
    assert runner.invoke(engine, scenario).total == total


def test_capture_production_statements_replay_and_listener_cleanup(archive):
    engine, dataset, _ = archive
    scenario = Scenario(
        "search", "text search", query=CatalogSavedQuery(search="vulpes wildlife")
    )
    response, calls = runner.capture(engine, scenario)
    Oracle(dataset).verify(scenario, response)
    assert [role for role, _, _ in calls] == list(runner.CATALOG_ROLES)
    components = runner.profile(engine, calls, 1, {})
    assert len(components) == 5
    assert components[0]["plan_summary"]["substring_predicate"]
    for role, (statement, parameters), _sql in calls:
        rows = runner.replay(engine, statement, parameters)
        if role == "filtered_count":
            assert rows[0][0] == response.total
        elif role == "items":
            assert [row[0].id for row in rows] == [photo.id for photo in response.items]
    assert len(engine.dispatch.before_cursor_execute) == 0
    with Session(engine) as session:
        invalid = SmartCollection(
            id=99, name="Bad", name_key="bad", query_version=99, query_json="{}"
        )
        session.add(invalid)
        session.commit()
    with pytest.raises(HTTPException) as error:
        runner.capture(
            engine,
            Scenario(
                "bad", "Smart Collection result queries", kind="smart", collection_id=99
            ),
        )
    assert error.value.status_code == 422
    assert len(engine.dispatch.before_cursor_execute) == 0


def test_statistics_and_warmups():
    assert runner.statistics_ms([1_000_000, 3_000_000])["median_ms"] == 2
    assert runner.statistics_ms([1_000_000])["p95_ms"] is None
    assert (
        runner.statistics_ms([index * 1_000_000 for index in range(1, 21)])["p95_ms"]
        == 19
    )
    calls = []
    result = runner.measure(lambda: calls.append(True), 3)
    assert len(calls) == 5
    assert result["iterations"] == 3


@pytest.mark.parametrize("kind", ["catalog", "smart"])
def test_capture_zero_count_has_no_items_and_keeps_roles_and_cleanup(archive, kind):
    engine, dataset, _ = archive
    query = CatalogSavedQuery(search="no-such-benchmark-match")
    with Session(engine) as session:
        if kind == "smart":
            session.add(
                SmartCollection(
                    id=90,
                    name="Absent",
                    name_key="absent",
                    query_version=1,
                    query_json=query.model_dump_json(),
                )
            )
            session.commit()
    scenario = Scenario(
        "absent", "text search", kind=kind, query=query, collection_id=90
    )
    response, calls = runner.capture(engine, scenario)
    Oracle(dataset).verify(scenario, response)
    expected = [role for role in runner.ROLES[kind] if role != "items"]
    assert [role for role, _, _ in calls] == expected
    assert response.total == 0
    assert response.facets.active_total > 0
    assert len(runner.profile(engine, calls, 1, {})) == len(expected)
    assert len(engine.dispatch.before_cursor_execute) == 0


def test_capture_rejects_extra_statement_even_for_zero_count(archive, monkeypatch):
    engine, _, _ = archive
    original = catalog.list_catalog_photos

    def extra_query(session, **kwargs):
        response = original(session, **kwargs)
        session.exec(select(Photo.id).limit(1)).all()
        return response

    monkeypatch.setattr(catalog, "list_catalog_photos", extra_query)
    scenario = Scenario(
        "absent", "text search", query=CatalogSavedQuery(search="absent")
    )
    with pytest.raises(
        safety.BenchmarkError, match="Unexpected production query shape"
    ):
        runner.capture(engine, scenario)
    assert len(engine.dispatch.before_cursor_execute) == 0


def test_isolation_ignores_hostile_environment_and_cleans_up(tmp_path, monkeypatch):
    live = tmp_path / "live"
    live.mkdir()
    sentinel = live / "sentinel.db"
    sentinel.write_bytes(b"real archive sentinel")
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{sentinel}")
    monkeypatch.setenv("DATA_DIR", str(live))
    monkeypatch.setenv("IMAGE_DIR", str(live / "images"))
    monkeypatch.setenv("OLLAMA_REQUEST_TIMEOUT_SECONDS", "invalid")
    protected = safety.protected_locations()
    with safety.disposable_settings(protected) as settings:
        root = settings.database_path.parent
        assert root != live
        assert settings.ollama_request_timeout_seconds == 180
        assert safety.IsolatedSettings.model_config["env_file"] is not None
    assert not root.exists()
    assert sentinel.read_bytes() == b"real archive sentinel"
    assert sorted(path.name for path in live.iterdir()) == ["sentinel.db"]


@pytest.mark.parametrize(
    "exception", [RuntimeError("synthetic failure"), KeyboardInterrupt()]
)
def test_runner_cleans_up_on_failure_and_interrupt(tmp_path, monkeypatch, exception):
    def fail(_size):
        raise exception

    monkeypatch.setattr(runner, "generate_dataset", fail)
    with pytest.raises(type(exception)):
        runner.benchmark_size(60, 1, (), progress=lambda *args, **kwargs: None)
    assert list(tmp_path.iterdir()) == []


def test_output_safety_no_overwrite_and_storage_overlap(tmp_path):
    live = tmp_path / "live"
    live.mkdir()
    with pytest.raises(safety.BenchmarkError, match="overlaps"):
        safety.validate_output(live / "report.json", (live,))
    report = tmp_path / "report.json"
    safety.publish_report(report, {"format_version": 1}, (live,))
    assert json.loads(report.read_text()) == {"format_version": 1}
    with pytest.raises(safety.BenchmarkError, match="already exists"):
        safety.publish_report(report, {"replacement": True}, (live,))
    assert json.loads(report.read_text()) == {"format_version": 1}
    assert not list(tmp_path.glob(".catalog-report-*"))


def test_output_rejects_linked_parent(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    link = tmp_path / "link"
    try:
        link.symlink_to(source, target_is_directory=True)
    except OSError:
        pytest.skip("platform does not allow unprivileged symlinks")
    with pytest.raises(safety.BenchmarkError, match="links"):
        safety.validate_output(link / "report.json", ())


def test_temp_parent_inside_production_storage_is_refused(tmp_path):
    with pytest.raises(safety.BenchmarkError, match="overlaps"):
        with safety.disposable_settings((tmp_path,)):
            pytest.fail("must refuse before creation")
    assert list(tmp_path.iterdir()) == []


def test_database_directory_and_sidecars_are_protected_outside_data_dir(
    tmp_path, monkeypatch
):
    database_dir = tmp_path / "database"
    database_dir.mkdir()
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{database_dir / 'live.db'}")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "separate-data"))
    monkeypatch.setenv("IMAGE_DIR", str(tmp_path / "separate-images"))
    protected = safety.protected_locations()
    for name in ("report.json", "live.db-wal", "live.db-shm", "live.db-journal"):
        with pytest.raises(safety.BenchmarkError, match="overlaps"):
            safety.validate_output(database_dir / name, protected)
    assert list(database_dir.iterdir()) == []


@pytest.mark.parametrize(
    "options",
    [
        ["--sizes", "0"],
        ["--runs", "-1"],
        ["--runs", "bad"],
        ["--sizes"],
        ["--database", "live.db"],
    ],
)
def test_cli_invalid_arguments(options):
    with pytest.raises(SystemExit) as error:
        benchmark_catalog.main(options)
    assert error.value.code == 2


def test_small_report_correctness_schema_privacy_and_cleanup(tmp_path):
    report = runner.run_benchmarks([60], 1, (), progress=lambda *args, **kwargs: None)
    assert report["format_version"] == report["dataset_version"] == 1
    assert report["environment"]["sqlite_version"]
    assert report["methodology"]["experimental_fts"] is False
    dataset = report["datasets"][0]
    assert dataset["distributions"]["photos"] == 60
    assert len(dataset["scenarios"]) == 67
    map_scenarios = [item for item in dataset["scenarios"] if item["kind"] == "map"]
    assert len(map_scenarios) == 12
    assert all(
        item["query_count"] == 1 and item["criteria"] is not None
        for item in map_scenarios
    )
    assert len(dataset["smart_comparisons"]) == 5
    assert len(dataset["assessments"]) == 7
    assert set(dataset["phases_ms"]) == {
        "storage_schema_setup",
        "generation_insertion",
        "correctness_validation",
        "diagnostic_profiling",
        "benchmark_execution",
    }
    for scenario in dataset["scenarios"]:
        assert scenario["timing"]["iterations"] == 1
        assert scenario["timing"]["p95_ms"] is None
        assert scenario["components"]
    encoded = json.dumps(report, allow_nan=False)

    # Compare decoded JSON strings, so escaped Windows separators cannot hide paths.
    def strings(value):
        if isinstance(value, str):
            yield value.replace("\\", "/")
        elif isinstance(value, dict):
            for item in value.values():
                yield from strings(item)
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)

    serialized = list(strings(json.loads(encoded)))
    assert all(
        tmp_path.as_posix() not in value and "E:/FaunaVault" not in value
        for value in serialized
    )
    assert list(tmp_path.iterdir()) == []
    by_name = {item["name"]: item for item in dataset["scenarios"]}
    for pair in dataset["smart_comparisons"]:
        normal = by_name[pair["catalog"]]
        smart = by_name[pair["smart"]]
        assert normal["components"] == smart["components"][1:]


def test_cli_does_not_publish_failed_correctness(tmp_path, monkeypatch, capsys):
    output = tmp_path / "report.json"
    monkeypatch.setattr(benchmark_catalog, "protected_locations", lambda: ())

    def fail(*_args):
        raise safety.BenchmarkError("Correctness failed")

    monkeypatch.setattr(benchmark_catalog, "run_benchmarks", fail)
    assert (
        benchmark_catalog.main(
            ["--sizes", "60", "--runs", "1", "--output", str(output)]
        )
        == 1
    )
    assert not output.exists()
    assert "Correctness failed" in capsys.readouterr().err


@pytest.mark.parametrize("defect", ["count", "order", "duplicate", "facets"])
def test_oracle_rejects_wrong_production_responses(archive, defect):
    engine, dataset, _ = archive
    scenario = Scenario("wrong", "default catalog browsing")
    response = runner.invoke(engine, scenario)
    if defect == "count":
        response.total += 1
    elif defect == "order":
        response.items.reverse()
    elif defect == "duplicate":
        response.items[1] = response.items[0]
    else:
        response.facets.active_total += 1
    with pytest.raises(safety.BenchmarkError, match="Correctness failed"):
        Oracle(dataset).verify(scenario, response)


def test_capture_listener_cleanup_on_interrupt(archive, monkeypatch):
    engine, _, _ = archive

    def interrupt(*_args, **_kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(catalog, "list_catalog_photos", interrupt)
    with pytest.raises(KeyboardInterrupt):
        runner.capture(engine, Scenario("interrupt", "default catalog browsing"))
    assert len(engine.dispatch.before_cursor_execute) == 0


def test_import_does_not_load_global_engine_or_start_application():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import app.cli.benchmark_catalog; assert 'app.db' not in sys.modules; assert 'app.main' not in sys.modules",
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_cli_success_publishes_valid_json(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(benchmark_catalog, "protected_locations", lambda: ())
    output = tmp_path / "report.json"
    assert (
        benchmark_catalog.main(["--sizes", "1", "--runs", "1", "--output", str(output)])
        == 0
    )
    assert json.loads(output.read_text())["datasets"][0]["dataset_size"] == 1
    assert "Warm-cache" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == [output]
