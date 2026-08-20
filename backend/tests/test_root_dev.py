from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEV_SCRIPT = REPOSITORY_ROOT / "scripts" / "dev.py"


def load_dev_module():
    spec = importlib.util.spec_from_file_location("faunavault_root_dev", DEV_SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def dev():
    return load_dev_module()


def step_values(steps):
    return [(step.label, step.tool, step.arguments, step.cwd) for step in steps]


def test_help_exposes_only_the_supported_commands(dev):
    parser = dev.build_parser()
    subparser_action = next(
        action
        for action in parser._actions
        if isinstance(action, dev.argparse._SubParsersAction)
    )

    assert tuple(subparser_action.choices) == ("setup", "check", "backend", "frontend")
    help_text = parser.format_help()
    assert "setup" in help_text
    assert "check" in help_text
    assert "backend" in help_text
    assert "frontend" in help_text


def test_command_steps_match_the_documented_workflows(dev):
    assert step_values(dev.SETUP_STEPS) == [
        ("[backend] sync", "uv", ("sync",), dev.BACKEND_DIR),
        ("[frontend] install", "npm", ("ci",), dev.FRONTEND_DIR),
    ]
    assert step_values(dev.CHECK_STEPS) == [
        ("[backend] sync", "uv", ("sync", "--frozen"), dev.BACKEND_DIR),
        ("[backend] ruff check", "uv", ("run", "ruff", "check", "."), dev.BACKEND_DIR),
        (
            "[backend] ruff format",
            "uv",
            ("run", "ruff", "format", "--check", "."),
            dev.BACKEND_DIR,
        ),
        ("[backend] pytest", "uv", ("run", "pytest"), dev.BACKEND_DIR),
        ("[frontend] install", "npm", ("ci",), dev.FRONTEND_DIR),
        ("[frontend] lint", "npm", ("run", "lint"), dev.FRONTEND_DIR),
        ("[frontend] typecheck", "npm", ("run", "typecheck"), dev.FRONTEND_DIR),
        ("[frontend] test", "npm", ("test",), dev.FRONTEND_DIR),
        ("[frontend] build", "npm", ("run", "build"), dev.FRONTEND_DIR),
    ]
    assert step_values(dev.BACKEND_STEPS) == [
        (
            "[backend] development server",
            "uv",
            (
                "run",
                "uvicorn",
                "app.main:app",
                "--reload",
                "--host",
                "0.0.0.0",
                "--port",
                "8000",
            ),
            dev.BACKEND_DIR,
        )
    ]
    assert step_values(dev.FRONTEND_STEPS) == [
        ("[frontend] development server", "npm", ("run", "dev"), dev.FRONTEND_DIR)
    ]


def test_failure_propagates_and_stops_later_steps(dev, capsys):
    calls = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=23 if len(calls) == 2 else 0)

    result = dev.run_steps(
        dev.CHECK_STEPS,
        {"uv": "resolved-uv", "npm": "resolved-npm"},
        runner,
    )

    assert result == 23
    assert [call[0] for call in calls] == [
        ["resolved-uv", "sync", "--frozen"],
        ["resolved-uv", "run", "ruff", "check", "."],
    ]
    assert calls[0][1] == {"cwd": dev.BACKEND_DIR, "shell": False}
    assert "[backend] ruff check failed with exit code 23." in capsys.readouterr().err


def test_missing_tool_is_reported_before_any_step_runs(dev, capsys):
    looked_up = []
    runner_called = False

    def which(tool):
        looked_up.append(tool)
        return "resolved-uv" if tool == "uv" else None

    def runner(*_args, **_kwargs):
        nonlocal runner_called
        runner_called = True
        return SimpleNamespace(returncode=0)

    result = dev.run_command("setup", which=which, runner=runner)

    assert result == 127
    assert looked_up == ["uv", "npm"]
    assert runner_called is False
    assert (
        "npm was not found on PATH. Install Node.js 24+ and npm before running setup."
        in capsys.readouterr().err
    )


def test_resolved_windows_npm_command_is_executed_directly(dev):
    calls = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)

    result = dev.run_command(
        "frontend",
        which=lambda tool: r"C:\nvm4w\nodejs\npm.CMD",
        runner=runner,
    )

    assert result == 0
    assert calls == [
        (
            [r"C:\nvm4w\nodejs\npm.CMD", "run", "dev"],
            {"cwd": dev.FRONTEND_DIR, "shell": False},
        )
    ]


def test_arguments_and_working_directory_with_spaces_need_no_shell(dev, tmp_path):
    spaced_directory = tmp_path / "FaunaVault workspace"
    spaced_directory.mkdir()
    step = dev.Step(
        "[test] spaced path",
        "python",
        (
            "-c",
            "import pathlib, sys; sys.exit(0 if pathlib.Path.cwd().name == "
            "'FaunaVault workspace' else 1)",
        ),
        spaced_directory,
    )

    assert dev.run_steps((step,), {"python": sys.executable}) == 0


def test_repository_paths_do_not_depend_on_current_directory(
    dev, monkeypatch, tmp_path
):
    monkeypatch.chdir(tmp_path)

    assert dev.REPOSITORY_ROOT == REPOSITORY_ROOT
    assert dev.BACKEND_DIR == REPOSITORY_ROOT / "backend"
    assert dev.FRONTEND_DIR == REPOSITORY_ROOT / "frontend"


def test_keyboard_interrupt_returns_130_without_traceback(dev, capsys):
    def runner(*_args, **_kwargs):
        raise KeyboardInterrupt

    result = dev.run_command(
        "backend", which=lambda _tool: "resolved-uv", runner=runner
    )

    assert result == 130
    captured = capsys.readouterr()
    assert "Interrupted." in captured.err
    assert "Traceback" not in captured.err


def test_help_runs_by_absolute_path_from_another_directory(tmp_path):
    result = subprocess.run(
        [sys.executable, str(DEV_SCRIPT), "--help"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        shell=False,
    )

    assert result.returncode == 0
    assert "{setup,check,backend,frontend}" in result.stdout
