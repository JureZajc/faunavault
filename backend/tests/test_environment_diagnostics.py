from __future__ import annotations

import sqlite3

import httpx
import pytest

from app.benchmark.safety import IsolatedSettings
from app.cli.maintenance import main
from app.database import create_database_engine
from app.services.environment_diagnostics import environment_diagnostics
from app.storage_startup import initialize_archive_storage


@pytest.fixture
def settings(tmp_path):
    return IsolatedSettings(
        data_dir=tmp_path / "data",
        image_dir=tmp_path / "images",
        database_url=f"sqlite:///{tmp_path / 'data' / 'archive.db'}",
    )


def test_empty_environment_does_not_create_state_or_probe_ollama(settings):
    def reject(_request):
        raise AssertionError("No implicit Ollama probe")

    results = environment_diagnostics(settings, transport=httpx.MockTransport(reject))
    assert not any(item.status == "FAIL" for item in results)
    assert (
        next(item for item in results if item.code == "database").status == "OPTIONAL"
    )
    assert not settings.database_path.exists()
    assert not settings.image_dir.exists()


@pytest.mark.parametrize(
    "case", ["offline", "missing", "available", "malformed", "invalid_url"]
)
def test_ollama_is_optional_and_checks_models(settings, case):
    if case == "invalid_url":
        settings = settings.model_copy(
            update={"ollama_base_url": "http://localhost:bad"}
        )
    requests = []

    def respond(request):
        requests.append(request)
        if case == "offline":
            raise httpx.ConnectError("offline", request=request)
        return httpx.Response(
            200,
            json={
                "models": (
                    [{"name": settings.ai_primary_model}] if case == "available" else []
                )
            }
            if case != "malformed"
            else {"invalid": True},
        )

    results = environment_diagnostics(
        settings, ollama=True, transport=httpx.MockTransport(respond)
    )
    if case == "invalid_url":
        assert not requests
    else:
        assert len(requests) == 1 and requests[0].url.path == "/api/tags"
    assert not any(item.status == "FAIL" for item in results)
    if case in ("missing", "available"):
        assert next(item for item in results if item.code == "ollama_model").status == (
            "PASS" if case == "available" else "WARNING"
        )
    else:
        assert (
            next(item for item in results if item.code == "ollama").status == "OPTIONAL"
        )


def test_schema_readiness_is_read_only(settings):
    engine = create_database_engine(settings)
    initialize_archive_storage(engine, settings)
    engine.dispose()
    before = settings.database_path.read_bytes()
    assert (
        next(
            item for item in environment_diagnostics(settings) if item.code == "schema"
        ).status
        == "PASS"
    )
    assert settings.database_path.read_bytes() == before
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("DELETE FROM schema_migration WHERE version=13")
    before = settings.database_path.read_bytes()
    assert (
        next(
            item for item in environment_diagnostics(settings) if item.code == "schema"
        ).status
        == "WARNING"
    )
    assert settings.database_path.read_bytes() == before
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("DELETE FROM schema_migration WHERE version=10")
    assert (
        next(
            item for item in environment_diagnostics(settings) if item.code == "schema"
        ).status
        == "FAIL"
    )


def test_corrupt_database_and_non_directory_fail(settings):
    settings.database_path.parent.mkdir()
    settings.database_path.write_bytes(b"not SQLite")
    results = environment_diagnostics(settings)
    assert any(item.code == "database" and item.status == "FAIL" for item in results)
    settings.database_path.unlink()
    settings.image_dir.write_text("not a directory")
    assert any(item.status == "FAIL" for item in environment_diagnostics(settings))


def test_cli_environment_exit_codes_and_missing_archive(settings, monkeypatch, capsys):
    monkeypatch.setattr("app.cli.maintenance.get_settings", lambda: settings)
    assert main(["doctor", "--environment-only"]) == 0
    assert "OPTIONAL database" in capsys.readouterr().out
    assert main(["doctor"]) == 2
    assert main(["doctor", "--ollama"]) == 2

    def invalid():
        raise ValueError("Invalid SQLite configuration")

    monkeypatch.setattr("app.cli.maintenance.get_settings", invalid)
    assert main(["doctor", "--environment-only"]) == 2
    assert "Invalid SQLite configuration" in capsys.readouterr().err
