from __future__ import annotations

import importlib.util
import io
import json
import shlex
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

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
        "dev",
        "benchmark-catalog",
        "doctor",
    )
    help_text = parser.format_help()
    assert "Install/synchronize development dependencies." in help_text
    assert "Run local validation using installed dependencies." in help_text
    assert "Run clean CI-equivalent validation" in help_text
    assert "Start the FastAPI development server." in help_text
    assert "Start the Next.js development server." in help_text
    assert "Start both development servers in one terminal." in help_text


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
                "--reload-dir",
                "app",
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


@pytest.mark.parametrize("command", ["dev", "start"])
def test_frontend_servers_default_to_ipv4_loopback(command):
    package = json.loads(
        (REPOSITORY_ROOT / "frontend" / "package.json").read_text(encoding="utf-8")
    )
    # Root frontend/dev workflows use this script; leave Next's port default and
    # npm's forwarded --port override available to the isolated browser tests.
    assert shlex.split(package["scripts"][command]) == [
        "next",
        command,
        "--hostname",
        "127.0.0.1",
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


@pytest.fixture
def dev_runtime(dev, tmp_path, monkeypatch):
    """Installed dependencies and fake services; no development server is spawned."""
    monkeypatch.setattr(dev, "check_dependencies_installed", lambda: True)
    monkeypatch.setattr(dev, "backend_python", lambda: Path(sys.executable))
    monkeypatch.setattr(dev, "FRONTEND_DEPENDENCIES_DIR", tmp_path)
    next_entry = tmp_path / "next/dist/bin/next"
    next_entry.parent.mkdir(parents=True)
    next_entry.touch()
    processes = [
        Mock(pid=pid, stdout=io.StringIO(f"service {pid}\nlast line"))
        for pid in (101, 102)
    ]
    for process in processes:
        process.poll.return_value = None
        process.wait.return_value = 0
    popen = Mock(side_effect=processes)
    runner = Mock(return_value=SimpleNamespace(returncode=0, stdout="v24.12.0"))
    job = Mock()
    monkeypatch.setattr(dev, "WindowsJob", Mock(return_value=job))
    monkeypatch.setattr(dev.subprocess, "Popen", popen)
    monkeypatch.setattr(dev.subprocess, "run", Mock())
    monkeypatch.setattr(dev.subprocess, "CREATE_NEW_PROCESS_GROUP", 512, raising=False)
    monkeypatch.setattr(dev.subprocess, "CREATE_NEW_CONSOLE", 16, raising=False)
    monkeypatch.setattr(dev.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    monkeypatch.setattr(dev.subprocess, "STARTF_USESHOWWINDOW", 1, raising=False)
    monkeypatch.setattr(dev.subprocess, "SW_HIDE", 0, raising=False)
    monkeypatch.setattr(
        dev.subprocess,
        "STARTUPINFO",
        lambda: SimpleNamespace(dwFlags=0, wShowWindow=1),
        raising=False,
    )
    monkeypatch.setattr(dev, "interrupt_windows_backend", Mock())
    monkeypatch.setattr(dev.signal, "CTRL_BREAK_EVENT", 1, raising=False)
    monkeypatch.setattr(dev.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(dev.time, "sleep", Mock(side_effect=KeyboardInterrupt))
    monkeypatch.setattr(dev, "os", SimpleNamespace(name="posix", killpg=Mock()))
    return SimpleNamespace(
        processes=processes,
        popen=popen,
        runner=runner,
        job=job,
        run=lambda: dev.run_dev(which=lambda tool: f"resolved-{tool}", runner=runner),
    )


@pytest.mark.parametrize("platform", ["nt", "posix"])
def test_dev_starts_both_services_and_ctrl_c_stops_their_trees(
    dev, dev_runtime, platform, capsys
):
    dev.os.name = platform
    previous_handler = dev.signal.getsignal(dev.signal.SIGINT)

    assert dev_runtime.run() == 130

    calls = dev_runtime.popen.call_args_list
    assert len(calls) == 2
    for call, step in zip(calls, dev.BACKEND_STEPS + dev.FRONTEND_STEPS, strict=True):
        if platform == "nt" and step.tool == "uv":
            assert call.args[0] == [
                sys.executable,
                str(DEV_SCRIPT.with_name("windows_backend.py")),
                *step.arguments[3:],
            ]
        else:
            assert call.args[0] == [f"resolved-{step.tool}", *step.arguments]
        assert call.kwargs["cwd"] == step.cwd
        assert call.kwargs["shell"] is False
        assert call.kwargs["stdout"] == subprocess.PIPE
        assert call.kwargs["stderr"] == subprocess.STDOUT
        assert call.kwargs["text"] is True
        if platform == "nt":
            if step.tool == "uv":
                assert call.kwargs["creationflags"] == subprocess.CREATE_NEW_CONSOLE
                startup = call.kwargs["startupinfo"]
                assert startup.dwFlags & subprocess.STARTF_USESHOWWINDOW
                assert startup.wShowWindow == subprocess.SW_HIDE
            else:
                assert (
                    call.kwargs["creationflags"] == subprocess.CREATE_NEW_PROCESS_GROUP
                )
                assert "startupinfo" not in call.kwargs
            assert "start_new_session" not in call.kwargs
        else:
            assert call.kwargs["start_new_session"] is True
            assert "creationflags" not in call.kwargs
    # Readiness probes are read-only; no sync or install is run.
    assert dev_runtime.runner.call_args_list[0].args[0] == [
        "resolved-node",
        "--version",
    ]
    assert dev_runtime.runner.call_args_list[1].args[0] == [
        sys.executable,
        "-c",
        dev.BACKEND_IMPORT_PROBE,
    ]
    assert dev_runtime.runner.call_args_list[1].kwargs["cwd"] == dev.BACKEND_DIR
    for process in dev_runtime.processes:
        assert process.stdout.closed
        assert process.wait.called
        if platform == "nt":
            if process is dev_runtime.processes[0]:
                dev.interrupt_windows_backend.assert_called_once_with(process)
                process.send_signal.assert_not_called()
            else:
                process.send_signal.assert_called_once_with(dev.signal.CTRL_BREAK_EVENT)
        else:
            assert (process.pid, dev.signal.SIGTERM) in [
                call.args for call in dev.os.killpg.call_args_list
            ]
            assert (process.pid, dev.signal.SIGKILL) in [
                call.args for call in dev.os.killpg.call_args_list
            ]
    if platform == "nt":
        assert [call.args[0] for call in dev_runtime.job.add.call_args_list] == (
            dev_runtime.processes
        )
        dev_runtime.job.close.assert_called_once()
    assert dev.signal.getsignal(dev.signal.SIGINT) == previous_handler
    captured = capsys.readouterr()
    for url in (
        "http://localhost:3000",
        "http://localhost:8000",
        "http://localhost:8000/health",
    ):
        assert url in captured.out
    for line in (
        "[backend] service 101",
        "[backend] last line",
        "[frontend] service 102",
        "[frontend] last line",
    ):
        assert line in captured.out.splitlines()
    assert "stopping both servers" in captured.err


@pytest.mark.parametrize("platform", ["nt", "posix"])
@pytest.mark.parametrize("service_index", [0, 1])
@pytest.mark.parametrize("exit_code,expected", [(23, 23), (0, 1), (-15, 143)])
def test_dev_unexpected_exit_stops_both_trees(
    dev, dev_runtime, platform, service_index, exit_code, expected, capsys
):
    dev.os.name = platform
    exited = dev_runtime.processes[service_index]
    exited.poll.return_value = exit_code

    assert dev_runtime.run() == expected

    assert dev_runtime.popen.call_count == 2
    assert all(process.wait.called for process in dev_runtime.processes)
    if platform == "nt":
        dev_runtime.job.close.assert_called_once()
        exited.send_signal.assert_not_called()
    else:
        # Include the group whose leader has exited: it can still contain workers.
        assert (exited.pid, dev.signal.SIGTERM) in [
            call.args for call in dev.os.killpg.call_args_list
        ]
        assert (exited.pid, dev.signal.SIGKILL) in [
            call.args for call in dev.os.killpg.call_args_list
        ]
    name = ("backend", "frontend")[service_index]
    assert (
        f"[{name}] development server exited unexpectedly with exit code {exit_code}"
        in (capsys.readouterr().err)
    )


@pytest.mark.parametrize("failed_index", [0, 1])
def test_dev_startup_failure_cleans_up_started_service(
    dev, dev_runtime, failed_index, capsys
):
    dev_runtime.popen.side_effect = [
        *dev_runtime.processes[:failed_index],
        OSError("could not spawn"),
    ]

    assert dev_runtime.run() == 1

    assert dev_runtime.popen.call_count == failed_index + 1
    for process in dev_runtime.processes[:failed_index]:
        assert process.wait.called
    for process in dev_runtime.processes[failed_index:]:
        process.wait.assert_not_called()
    name = ("backend", "frontend")[failed_index]
    assert f"[{name}] development server failed: could not spawn" in (
        capsys.readouterr().err
    )


def test_dev_interrupt_during_startup_cleans_up_first_service(dev_runtime):
    dev_runtime.popen.side_effect = [dev_runtime.processes[0], KeyboardInterrupt]

    assert dev_runtime.run() == 130
    assert dev_runtime.processes[0].wait.called
    dev_runtime.processes[1].wait.assert_not_called()


@pytest.mark.parametrize("failure", ["create", "assign"])
def test_dev_windows_job_failure_is_reported_and_cleaned_up(
    dev, dev_runtime, failure, capsys
):
    dev.os.name = "nt"
    if failure == "create":
        dev.WindowsJob.side_effect = OSError("job failed")
    else:
        dev_runtime.job.add.side_effect = OSError("job failed")

    assert dev_runtime.run() == 1

    if failure == "create":
        dev_runtime.popen.assert_not_called()
    else:
        dev_runtime.job.close.assert_called_once()
        assert dev_runtime.processes[0].wait.called
        assert dev.subprocess.run.call_args.args[0] == [
            "taskkill",
            "/PID",
            "101",
            "/T",
            "/F",
        ]
    assert "job failed" in capsys.readouterr().err


@pytest.mark.parametrize("platform", ["nt", "posix"])
def test_dev_escalates_shutdown_after_grace_period(dev, dev_runtime, platform):
    dev.os.name = platform
    dev_runtime.processes[0].wait.side_effect = [
        subprocess.TimeoutExpired("server", 5),
        0,
    ]

    assert dev_runtime.run() == 130

    assert dev_runtime.processes[0].wait.call_count == 2
    if platform == "nt":
        dev_runtime.job.close.assert_called_once()
    else:
        assert (101, dev.signal.SIGKILL) in [
            call.args for call in dev.os.killpg.call_args_list
        ]


@pytest.mark.parametrize("missing", ["backend", "frontend"])
def test_dev_requires_dependencies_before_spawning(
    dev, tmp_path, monkeypatch, missing, capsys
):
    monkeypatch.setattr(
        dev,
        "BACKEND_ENV_DIR",
        tmp_path / ("missing" if missing == "backend" else "installed"),
    )
    monkeypatch.setattr(
        dev,
        "FRONTEND_DEPENDENCIES_DIR",
        tmp_path / ("missing" if missing == "frontend" else "installed"),
    )
    (tmp_path / "installed").mkdir()
    popen = Mock()
    monkeypatch.setattr(dev.subprocess, "Popen", popen)
    runner = Mock()

    assert dev.run_dev(which=lambda tool: tool, runner=runner) == 1

    popen.assert_not_called()
    runner.assert_not_called()
    assert "python scripts/dev.py setup" in capsys.readouterr().err


@pytest.mark.parametrize("missing", ["uv", "npm"])
def test_dev_missing_tool_is_actionable(dev, monkeypatch, missing, capsys):
    popen = Mock()
    monkeypatch.setattr(dev.subprocess, "Popen", popen)

    assert dev.run_dev(which=lambda tool: None if tool == missing else tool) == 127

    popen.assert_not_called()
    captured = capsys.readouterr()
    assert f"{missing} was not found" in captured.err
    assert "python scripts/dev.py setup" in captured.err


@pytest.mark.parametrize("missing", ["interpreter", "next", "imports", "node"])
def test_dev_incomplete_dependencies_are_actionable(
    dev, dev_runtime, tmp_path, monkeypatch, missing, capsys
):
    if missing == "interpreter":
        monkeypatch.setattr(dev, "backend_python", lambda: tmp_path / "missing")
    elif missing == "next":
        (dev.FRONTEND_DEPENDENCIES_DIR / "next/dist/bin/next").unlink()
    elif missing == "imports":
        dev_runtime.runner.side_effect = [
            SimpleNamespace(returncode=0, stdout="v24.12.0"),
            SimpleNamespace(returncode=1),
        ]
    else:
        dev_runtime.runner.return_value.stdout = "v22.0.0"

    assert dev_runtime.run() == (2 if missing == "node" else 1)

    dev_runtime.popen.assert_not_called()
    message = capsys.readouterr().err
    assert ("Node" if missing == "node" else "python scripts/dev.py setup") in message


def test_dev_main_dispatches_to_concurrent_runner(dev, monkeypatch):
    run_dev = Mock(return_value=130)
    monkeypatch.setattr(dev, "run_dev", run_dev)

    assert dev.main(["dev"]) == 130
    run_dev.assert_called_once_with()


def test_backend_main_uses_managed_server_lifecycle(dev, monkeypatch):
    run_dev = Mock(return_value=130)
    monkeypatch.setattr(dev, "run_dev", run_dev)
    assert dev.main(["backend"]) == 130
    run_dev.assert_called_once_with(backend_only=True)


@pytest.mark.parametrize("platform", ["nt", "posix"])
def test_backend_only_needs_no_frontend_and_stops_its_workers(
    dev, dev_runtime, platform, capsys
):
    dev.os.name = platform
    (dev.FRONTEND_DEPENDENCIES_DIR / "next/dist/bin/next").unlink()
    assert (
        dev.run_dev(
            backend_only=True, which=lambda tool: tool, runner=dev_runtime.runner
        )
        == 130
    )
    assert dev_runtime.popen.call_count == 1
    assert dev_runtime.processes[0].wait.called
    dev_runtime.processes[1].wait.assert_not_called()
    assert dev_runtime.runner.call_args_list[0].args[0] == [
        sys.executable,
        "-c",
        dev.BACKEND_IMPORT_PROBE,
    ]
    captured = capsys.readouterr()
    assert "http://localhost:3000" not in captured.out
    assert "Interrupted; stopping backend." in captured.err


@pytest.mark.parametrize("failure", [None, "create", "configure", "assign"])
def test_windows_job_owns_descendants_and_releases_handle(dev, monkeypatch, failure):
    import ctypes

    kernel = SimpleNamespace(
        CreateJobObjectW=Mock(return_value=0 if failure == "create" else 44),
        SetInformationJobObject=Mock(return_value=failure != "configure"),
        AssignProcessToJobObject=Mock(return_value=failure != "assign"),
        CloseHandle=Mock(return_value=True),
    )
    monkeypatch.setattr(ctypes, "WinDLL", Mock(return_value=kernel), raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    monkeypatch.setattr(
        ctypes, "WinError", lambda code: OSError(code, "job failed"), raising=False
    )

    if failure in ("create", "configure"):
        with pytest.raises(OSError, match="job failed"):
            dev.WindowsJob()
        if failure == "configure":
            kernel.CloseHandle.assert_called_once_with(44)
        else:
            kernel.CloseHandle.assert_not_called()
        return

    job = dev.WindowsJob()
    handle, information_class, pointer, size = (
        kernel.SetInformationJobObject.call_args.args
    )
    assert handle == 44
    assert information_class == 9  # JobObjectExtendedLimitInformation
    assert pointer._obj.basic.flags == 0x2000  # KILL_ON_JOB_CLOSE
    assert size == ctypes.sizeof(pointer._obj)
    process = SimpleNamespace(_handle=77)
    try:
        if failure == "assign":
            with pytest.raises(OSError, match="job failed"):
                job.add(process)
        else:
            job.add(process)
        kernel.AssignProcessToJobObject.assert_called_once_with(44, 77)
    finally:
        job.close()
        job.close()
    kernel.CloseHandle.assert_called_once_with(44)


@pytest.mark.parametrize("failure", [None, "attach", "handler", "event"])
def test_windows_console_interrupt_is_scoped_and_detaches(dev, monkeypatch, failure):
    import ctypes

    calls = []

    def native(name, result=True):
        return Mock(side_effect=lambda *args: calls.append((name, args)) or result)

    kernel = SimpleNamespace(
        FreeConsole=native("free"),
        AttachConsole=native("attach", failure != "attach"),
        SetConsoleCtrlHandler=native("handler", failure != "handler"),
        GenerateConsoleCtrlEvent=native("event", failure != "event"),
    )
    monkeypatch.setattr(ctypes, "WinDLL", Mock(return_value=kernel), raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    monkeypatch.setattr(
        ctypes, "WinError", lambda code: OSError(code, "console failed"), raising=False
    )
    monkeypatch.setattr(dev.signal, "CTRL_C_EVENT", 0, raising=False)
    if failure:
        with pytest.raises(OSError, match="console failed"):
            dev.interrupt_windows_console(101)
    else:
        dev.interrupt_windows_console(101)
    assert calls[:2] == [("free", ()), ("attach", (101,))]
    if failure != "attach":
        assert calls[2] == ("handler", (None, True))
        assert calls[-1] == ("free", ())
    if failure in (None, "event"):
        assert calls[3] == ("event", (0, 0))


def test_windows_backend_shutdown_uses_windowless_helper(dev, monkeypatch):
    runner = Mock()
    monkeypatch.setattr(dev.subprocess, "run", runner)
    monkeypatch.setattr(dev.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)
    dev.interrupt_windows_backend(SimpleNamespace(pid=101))
    call = runner.call_args
    assert call.args[0][0:2] == [sys.executable, "-c"]
    assert call.args[0][-2:] == [str(DEV_SCRIPT), "101"]
    assert call.kwargs["creationflags"] == 0x08000000
    assert call.kwargs["shell"] is False
    assert call.kwargs["timeout"] == 2
    assert call.kwargs["check"] is True


@pytest.mark.parametrize(
    "failure",
    [
        OSError("attach failed"),
        subprocess.TimeoutExpired("helper", 2),
        subprocess.CalledProcessError(1, "helper"),
    ],
)
def test_windows_console_failure_still_closes_job_and_reaps_children(
    dev, dev_runtime, failure, capsys
):
    dev.os.name = "nt"
    dev.interrupt_windows_backend.side_effect = failure
    assert dev_runtime.run() == 130
    dev_runtime.job.close.assert_called_once()
    assert all(process.wait.called for process in dev_runtime.processes)
    assert "Shutdown signal failed" in capsys.readouterr().err
