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

    assert tuple(subparser_action.choices) == (
        "setup",
        "check",
        "check-clean",
        "backend",
        "frontend",
        "benchmark-catalog",
        "doctor",
    )
    help_text = parser.format_help()
    assert "Install/synchronize development dependencies." in help_text
    assert "Run local validation using installed dependencies." in help_text
    assert "Run clean CI-equivalent validation" in help_text
    assert "Start the FastAPI development server." in help_text
    assert "Start the Next.js development server." in help_text


def test_command_steps_match_the_documented_workflows(dev):
    assert step_values(dev.SETUP_STEPS) == [
        ("[backend] sync", "uv", ("sync", "--frozen"), dev.BACKEND_DIR),
        ("[frontend] install", "npm", ("ci",), dev.FRONTEND_DIR),
    ]
    assert step_values(dev.CHECK_STEPS) == [
        (
            "[backend] ruff check",
            "uv",
            ("run", "--no-sync", "ruff", "check", "."),
            dev.BACKEND_DIR,
        ),
        (
            "[backend] ruff format",
            "uv",
            ("run", "--no-sync", "ruff", "format", "--check", "."),
            dev.BACKEND_DIR,
        ),
        (
            "[backend] pytest",
            "uv",
            ("run", "--no-sync", "pytest"),
            dev.BACKEND_DIR,
        ),
        ("[frontend] lint", "npm", ("run", "lint"), dev.FRONTEND_DIR),
        ("[frontend] typecheck", "npm", ("run", "typecheck"), dev.FRONTEND_DIR),
        ("[frontend] test", "npm", ("test",), dev.FRONTEND_DIR),
        ("[frontend] build", "npm", ("run", "build"), dev.FRONTEND_DIR),
    ]
    assert step_values(dev.CHECK_CLEAN_STEPS) == [
        ("[backend] sync", "uv", ("sync", "--frozen"), dev.BACKEND_DIR),
        (
            "[backend] ruff check",
            "uv",
            ("run", "--no-sync", "ruff", "check", "."),
            dev.BACKEND_DIR,
        ),
        (
            "[backend] ruff format",
            "uv",
            ("run", "--no-sync", "ruff", "format", "--check", "."),
            dev.BACKEND_DIR,
        ),
        (
            "[backend] pytest",
            "uv",
            ("run", "--no-sync", "pytest"),
            dev.BACKEND_DIR,
        ),
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
                "--no-sync",
                "uvicorn",
                "app.main:app",
                "--reload",
                "--host",
                "127.0.0.1",
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
        ["resolved-uv", "run", "--no-sync", "ruff", "check", "."],
        ["resolved-uv", "run", "--no-sync", "ruff", "format", "--check", "."],
    ]
    assert calls[0][1] == {"cwd": dev.BACKEND_DIR, "shell": False}
    captured = capsys.readouterr()
    assert "[backend] ruff format failed with exit code 23." in captured.err
    assert "Frontend dependency installation failed." not in captured.err


@pytest.mark.parametrize(
    ("missing_directory", "component"),
    [
        ("BACKEND_ENV_DIR", "Backend"),
        ("FRONTEND_DEPENDENCIES_DIR", "Frontend"),
    ],
)
def test_check_requires_installed_dependencies(
    dev, capsys, missing_directory, component
):
    calls = []
    missing_path = getattr(dev, missing_directory)

    result = dev.run_command(
        "check",
        which=lambda tool: f"resolved-{tool}",
        runner=lambda *args, **kwargs: calls.append((args, kwargs)),
        directory_exists=lambda path: path != missing_path,
    )

    assert result == 1
    assert calls == []
    captured = capsys.readouterr()
    assert f"{component} dependencies are not installed." in captured.err
    assert "python scripts/dev.py setup" in captured.err
    assert "npm ci" not in captured.err


def test_check_runs_only_validation_steps_in_order(dev):
    calls = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)

    result = dev.run_command(
        "check",
        which=lambda tool: f"resolved-{tool}",
        runner=runner,
        directory_exists=lambda _path: True,
    )

    assert result == 0
    assert calls == [
        (
            [f"resolved-{step.tool}", *step.arguments],
            {"cwd": step.cwd, "shell": False},
        )
        for step in dev.CHECK_STEPS
    ]
    assert not any(command[1:3] == ["sync", "--frozen"] for command, _ in calls)
    assert not any(command[1:] == ["ci"] for command, _ in calls)


def test_check_clean_runs_ci_equivalent_steps_in_order(dev):
    calls = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0)

    result = dev.run_command(
        "check-clean", which=lambda tool: f"resolved-{tool}", runner=runner
    )

    assert result == 0
    assert calls == [
        (
            [f"resolved-{step.tool}", *step.arguments],
            {"cwd": step.cwd, "shell": False},
        )
        for step in dev.CHECK_CLEAN_STEPS
    ]
    assert calls[0][0][1:] == ["sync", "--frozen"]
    assert calls[4][0][1:] == ["ci"]


@pytest.mark.parametrize("command", ["setup", "check-clean"])
def test_frontend_install_failure_is_actionable(dev, command, capsys):
    calls = []

    def runner(arguments, **kwargs):
        calls.append((arguments, kwargs))
        return SimpleNamespace(returncode=29 if arguments[1:] == ["ci"] else 0)

    result = dev.run_command(
        command,
        which=lambda tool: f"resolved-{tool}",
        runner=runner,
    )

    assert result == 29
    assert calls[-1][0][1:] == ["ci"]
    captured = capsys.readouterr()
    assert "[frontend] install failed with exit code 29." in captured.err
    assert "Frontend dependency installation failed." in captured.err
    assert "On Windows" in captured.err
    assert "stop it with Ctrl+C" in captured.err
    assert "python scripts/dev.py setup" in captured.err


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
    assert "benchmark-catalog" in result.stdout


def test_benchmark_dispatch_preserves_options_and_callers_output_path(
    dev, tmp_path, monkeypatch
):
    calls = []
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(dev, "BACKEND_ENV_DIR", tmp_path)
    monkeypatch.setattr(dev, "FRONTEND_DEPENDENCIES_DIR", tmp_path / "missing-frontend")
    monkeypatch.setattr(dev, "resolve_tools", lambda _steps: {"uv": "resolved-uv"})
    monkeypatch.setattr(
        dev,
        "run_steps",
        lambda steps, executables: calls.append((steps, executables)) or 0,
    )
    assert (
        dev.main(
            [
                "benchmark-catalog",
                "--sizes",
                "60",
                "120",
                "--runs",
                "2",
                "--output",
                "report.json",
                "--verbose",
            ]
        )
        == 0
    )
    steps, executables = calls[0]
    assert executables == {"uv": "resolved-uv"}
    assert steps[0].cwd == dev.BACKEND_DIR
    assert steps[0].arguments == (
        "run",
        "--no-sync",
        "python",
        "-m",
        "app.cli.benchmark_catalog",
        "--sizes",
        "60",
        "120",
        "--runs",
        "2",
        "--output",
        str(tmp_path / "report.json"),
        "--verbose",
    )


def test_benchmark_requires_only_backend_dependencies(
    dev, tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(dev, "BACKEND_ENV_DIR", tmp_path / "missing")
    monkeypatch.setattr(
        dev, "resolve_tools", lambda _steps: pytest.fail("must fail before launching")
    )
    assert dev.main(["benchmark-catalog"]) == 1
    assert "Backend dependencies" in capsys.readouterr().err


@pytest.mark.parametrize(
    "options",
    [["--sizes", "0"], ["--runs", "-1"], ["--sizes", "bad"], ["--database", "live.db"]],
)
def test_benchmark_rejects_invalid_options(dev, options):
    with pytest.raises(SystemExit) as error:
        dev.build_parser().parse_args(["benchmark-catalog", *options])
    assert error.value.code == 2


@pytest.mark.parametrize(
    "version,ready", [("v24.12.0", True), ("v22.0.0", False), ("invalid", False)]
)
def test_node_readiness_is_actionable(dev, version, ready):
    result = dev.node_readiness(
        lambda _tool: "node",
        lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=version),
    )
    assert result[0] is ready
    assert "24+" in result[1]
    assert dev.node_readiness(lambda _tool: None)[0] is False


@pytest.mark.parametrize(
    "options", [[], ["--ollama"], ["--archive"], ["--archive", "--ollama"]]
)
def test_root_doctor_composes_existing_maintenance(dev, tmp_path, monkeypatch, options):
    monkeypatch.setattr(dev, "backend_python", lambda: Path(sys.executable))
    monkeypatch.setattr(dev, "FRONTEND_DEPENDENCIES_DIR", tmp_path)
    for entry in (
        "next/dist/bin/next",
        "eslint/bin/eslint.js",
        "typescript/bin/tsc",
        "vitest/vitest.mjs",
    ):
        marker = tmp_path / entry
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    calls = []

    def runner(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout="v24.12.0")

    args = dev.build_parser().parse_args(["doctor", *options])
    assert dev.run_doctor(args, which=lambda name: name, runner=runner) == 0
    maintenance = [command for command, _ in calls if "app.cli.maintenance" in command]
    assert maintenance[0][-1] == (
        "--ollama" if "--ollama" in options else "--environment-only"
    )
    assert "--environment-only" in maintenance[0]
    assert len(maintenance) == (2 if "--archive" in options else 1)
    if "--archive" in options:
        assert maintenance[1][-1] == "doctor"
    assert all(not kwargs["shell"] for _, kwargs in calls)


def test_root_doctor_missing_install_and_environment_failure(
    dev, tmp_path, monkeypatch, capsys
):
    args = dev.build_parser().parse_args(["doctor"])
    monkeypatch.setattr(dev, "backend_python", lambda: tmp_path / "missing")
    monkeypatch.setattr(dev, "FRONTEND_DEPENDENCIES_DIR", tmp_path / "missing")
    assert dev.run_doctor(args, which=lambda _name: None) == 1
    assert "FAIL backend_dependencies" in capsys.readouterr().out
    monkeypatch.setattr(dev, "backend_python", lambda: Path(sys.executable))

    def runner(command, **_kwargs):
        return SimpleNamespace(
            returncode=2 if "app.cli.maintenance" in command else 0, stdout="v24.12.0"
        )

    assert dev.run_doctor(args, which=lambda name: name, runner=runner) == 2


def test_root_doctor_incomplete_backend_imports(dev, monkeypatch, capsys):
    monkeypatch.setattr(dev, "backend_python", lambda: Path(sys.executable))

    def runner(command, **_kwargs):
        return SimpleNamespace(
            returncode=1 if "-c" in command else 0, stdout="v24.12.0"
        )

    assert (
        dev.run_doctor(
            dev.build_parser().parse_args(["doctor"]),
            which=lambda name: name,
            runner=runner,
        )
        == 1
    )
    assert "Required imports failed" in capsys.readouterr().out
