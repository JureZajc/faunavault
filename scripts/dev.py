"""Small, cross-platform developer workflow commands for FaunaVault."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

MINIMUM_PYTHON = (3, 12)
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPOSITORY_ROOT / "backend"
FRONTEND_DIR = REPOSITORY_ROOT / "frontend"
BACKEND_ENV_DIR = BACKEND_DIR / ".venv"
FRONTEND_DEPENDENCIES_DIR = FRONTEND_DIR / "node_modules"
OUTPUT_LOCK = threading.Lock()
BACKEND_IMPORT_PROBE = (
    "import sys; "
    "assert sys.version_info >= (3, 12), 'Backend requires Python 3.12+'; "
    "import fastapi, httpx, PIL, pillow_heif, pydantic_settings, dotenv, multipart, sqlmodel, uvicorn"
)


@dataclass(frozen=True)
class Step:
    label: str
    tool: str
    arguments: tuple[str, ...]
    cwd: Path


BACKEND_SETUP_STEP = Step("[backend] sync", "uv", ("sync", "--frozen"), BACKEND_DIR)
BACKEND_CLEAN_SETUP_STEP = Step(
    "[backend] sync", "uv", ("sync", "--frozen"), BACKEND_DIR
)
FRONTEND_SETUP_STEP = Step("[frontend] install", "npm", ("ci",), FRONTEND_DIR)

BACKEND_VALIDATION_STEPS = (
    Step(
        "[backend] ruff check",
        "uv",
        ("run", "--no-sync", "ruff", "check", "."),
        BACKEND_DIR,
    ),
    Step(
        "[backend] ruff format",
        "uv",
        ("run", "--no-sync", "ruff", "format", "--check", "."),
        BACKEND_DIR,
    ),
    Step("[backend] pytest", "uv", ("run", "--no-sync", "pytest"), BACKEND_DIR),
)

FRONTEND_VALIDATION_STEPS = (
    Step("[frontend] lint", "npm", ("run", "lint"), FRONTEND_DIR),
    Step("[frontend] typecheck", "npm", ("run", "typecheck"), FRONTEND_DIR),
    Step("[frontend] test", "npm", ("test",), FRONTEND_DIR),
    Step("[frontend] build", "npm", ("run", "build"), FRONTEND_DIR),
)

SETUP_STEPS = (BACKEND_SETUP_STEP, FRONTEND_SETUP_STEP)
CHECK_STEPS = BACKEND_VALIDATION_STEPS + FRONTEND_VALIDATION_STEPS

# Keep this sequence synchronized with .github/workflows/ci.yml. Validation uses
# the environment established by the explicit frozen sync without syncing again.
CHECK_CLEAN_STEPS = (
    BACKEND_CLEAN_SETUP_STEP,
    *BACKEND_VALIDATION_STEPS,
    FRONTEND_SETUP_STEP,
    *FRONTEND_VALIDATION_STEPS,
)

BACKEND_STEPS = (
    Step(
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
        BACKEND_DIR,
    ),
)

FRONTEND_STEPS = (
    Step("[frontend] development server", "npm", ("run", "dev"), FRONTEND_DIR),
)

COMMAND_STEPS = {
    "setup": SETUP_STEPS,
    "check": CHECK_STEPS,
    "check-clean": CHECK_CLEAN_STEPS,
    "backend": BACKEND_STEPS,
    "frontend": FRONTEND_STEPS,
}

INSTALL_HINTS = {
    "uv": "Install uv",
    "npm": "Install Node.js 24+ and npm",
}

Which = Callable[[str], str | None]
Runner = Callable[..., subprocess.CompletedProcess[bytes]]
DirectoryExists = Callable[[Path], bool]


class ToolNotFoundError(Exception):
    def __init__(self, tool: str) -> None:
        self.tool = tool
        super().__init__(tool)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run common FaunaVault developer workflows from the repository root."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("setup", help="Install/synchronize development dependencies.")
    subparsers.add_parser(
        "check", help="Run local validation using installed dependencies."
    )
    subparsers.add_parser(
        "check-clean",
        help="Run clean CI-equivalent validation, including dependency reinstall/sync.",
    )
    subparsers.add_parser("backend", help="Start the FastAPI development server.")
    subparsers.add_parser("frontend", help="Start the Next.js development server.")
    subparsers.add_parser("dev", help="Start both development servers in one terminal.")
    benchmark = subparsers.add_parser(
        "benchmark-catalog",
        help="Profile production queries on disposable synthetic data.",
    )
    benchmark.add_argument(
        "--sizes", nargs="+", type=positive_int, default=[1000, 10000, 50000, 100000]
    )
    benchmark.add_argument("--runs", type=positive_int, default=10)
    benchmark.add_argument("--output", type=Path)
    benchmark.add_argument("--verbose", action="store_true")
    doctor = subparsers.add_parser(
        "doctor", help="Check setup without changing the archive."
    )
    doctor.add_argument(
        "--archive",
        action="store_true",
        help="also scan archive integrity; stop the backend first",
    )
    doctor.add_argument(
        "--ollama",
        action="store_true",
        help="explicitly probe optional Ollama and configured models",
    )
    return parser


def node_readiness(
    which: Which = shutil.which, runner: Runner = subprocess.run
) -> tuple[bool, str]:
    node = which("node")
    if node is None:
        return False, "Install Node.js 24+ and npm; node was not found on PATH."
    try:
        result = runner(
            [node, "--version"], capture_output=True, text=True, timeout=10, shell=False
        )
        match = re.fullmatch(r"v(\d+)\.\d+\.\d+", result.stdout.strip())
        if result.returncode or match is None:
            return (
                False,
                "Could not determine Node version; install Node.js 24+ and npm.",
            )
        if int(match[1]) < 24:
            return (
                False,
                f"Node {result.stdout.strip()} is unsupported; install Node.js 24+.",
            )
        return True, f"Node {result.stdout.strip()}; requires 24+."
    except (OSError, subprocess.TimeoutExpired):
        return False, "Could not run node --version; check your Node.js installation."


def backend_python() -> Path:
    return BACKEND_ENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run_doctor(
    arguments: argparse.Namespace,
    *,
    which: Which = shutil.which,
    runner: Runner = subprocess.run,
) -> int:
    failed = False

    def report(ok: bool, code: str, message: str) -> None:
        nonlocal failed
        failed |= not ok
        print(f"{'PASS' if ok else 'FAIL'} {code}: {message}", flush=True)

    report(
        sys.version_info >= MINIMUM_PYTHON,
        "python",
        f"Python {sys.version.split()[0]}; requires 3.12+.",
    )
    for tool in ("uv", "npm"):
        report(
            which(tool) is not None,
            tool,
            f"{tool} available." if which(tool) else INSTALL_HINTS[tool] + ".",
        )
    node_ok, node_message = node_readiness(which, runner)
    report(node_ok, "node", node_message)
    frontend_entries = (
        "next/dist/bin/next",
        "eslint/bin/eslint.js",
        "typescript/bin/tsc",
        "vitest/vitest.mjs",
    )
    frontend_ok = all(
        (FRONTEND_DEPENDENCIES_DIR / entry).is_file() for entry in frontend_entries
    )
    report(
        frontend_ok,
        "frontend_dependencies",
        "Required commands installed."
        if frontend_ok
        else "Incomplete installation. Stop frontend and run python scripts/dev.py setup.",
    )
    interpreter = backend_python()
    if not interpreter.is_file():
        report(
            False,
            "backend_dependencies",
            "Run python scripts/dev.py setup to install the backend environment.",
        )
        return 1
    # Probe imports in the installed backend interpreter before invoking maintenance.
    try:
        result = runner(
            [str(interpreter), "-c", BACKEND_IMPORT_PROBE],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            timeout=30,
            shell=False,
        )
        if result.returncode:
            report(
                False,
                "backend_dependencies",
                "Required imports failed. Run python scripts/dev.py setup (use uv sync --python 3.12 --frozen for an unsupported backend Python).",
            )
            return 1
        report(True, "backend_dependencies", "Required imports available.")
        options = ["--environment-only"] + (["--ollama"] if arguments.ollama else [])
        result = runner(
            [str(interpreter), "-m", "app.cli.maintenance", "doctor", *options],
            cwd=BACKEND_DIR,
            shell=False,
        )
        if result.returncode:
            return result.returncode
        if arguments.archive:
            print(
                "Archive scan requires the backend stopped for the entire operation.",
                flush=True,
            )
            result = runner(
                [str(interpreter), "-m", "app.cli.maintenance", "doctor"],
                cwd=BACKEND_DIR,
                shell=False,
            )
            if result.returncode:
                return result.returncode
        return 1 if failed else 0
    except (OSError, subprocess.TimeoutExpired) as error:
        print(
            f"FAIL backend_dependencies: Could not run installed backend ({type(error).__name__}); rerun setup.",
            file=sys.stderr,
        )
        return 2
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def run_benchmark(arguments: argparse.Namespace) -> int:
    if not BACKEND_ENV_DIR.is_dir():
        print(
            "Backend dependencies are not installed. Run python scripts/dev.py setup.",
            file=sys.stderr,
        )
        return 1
    options = [
        "--sizes",
        *(str(size) for size in arguments.sizes),
        "--runs",
        str(arguments.runs),
    ]
    if arguments.output is not None:
        options.extend(("--output", str(arguments.output.expanduser().absolute())))
    if arguments.verbose:
        options.append("--verbose")
    step = Step(
        "[backend] catalog benchmark",
        "uv",
        ("run", "--no-sync", "python", "-m", "app.cli.benchmark_catalog", *options),
        BACKEND_DIR,
    )
    try:
        return run_steps((step,), resolve_tools((step,)))
    except ToolNotFoundError:
        print(
            "uv was not found on PATH. Install uv before running benchmark-catalog.",
            file=sys.stderr,
        )
        return 127
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130


def required_tools(steps: Sequence[Step]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(step.tool for step in steps))


def resolve_tools(steps: Sequence[Step], which: Which = shutil.which) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for tool in required_tools(steps):
        executable = which(tool)
        if executable is None:
            raise ToolNotFoundError(tool)
        resolved[tool] = executable
    return resolved


def check_dependencies_installed(
    directory_exists: DirectoryExists = Path.is_dir,
) -> bool:
    missing: list[str] = []
    if not directory_exists(BACKEND_ENV_DIR):
        missing.append("Backend")
    if not directory_exists(FRONTEND_DEPENDENCIES_DIR):
        missing.append("Frontend")

    if not missing:
        return True

    subject = missing[0] if len(missing) == 1 else "Backend and frontend"
    print(
        f"{subject} dependencies are not installed. Run:\n\n"
        "    python scripts/dev.py setup",
        file=sys.stderr,
    )
    return False


def is_frontend_install(step: Step) -> bool:
    return step.tool == "npm" and step.arguments == ("ci",) and step.cwd == FRONTEND_DIR


def print_frontend_install_failure_hint() -> None:
    print(
        "Frontend dependency installation failed.\n\n"
        "On Windows, if a Next.js development server is running, stop it with "
        "Ctrl+C before retrying because native modules in node_modules can be "
        "locked.\n\n"
        "If npm ci was interrupted after removing files, rerun:\n\n"
        "    python scripts/dev.py setup\n\n"
        "after stopping the frontend server.",
        file=sys.stderr,
        flush=True,
    )


def run_steps(
    steps: Sequence[Step],
    executables: dict[str, str],
    runner: Runner = subprocess.run,
) -> int:
    for step in steps:
        print(step.label, flush=True)
        command = [executables[step.tool], *step.arguments]
        result = runner(command, cwd=step.cwd, shell=False)
        if result.returncode != 0:
            print(
                f"{step.label} failed with exit code {result.returncode}.",
                file=sys.stderr,
                flush=True,
            )
            if is_frontend_install(step):
                print_frontend_install_failure_hint()
            return result.returncode
    return 0


def run_command(
    command: str,
    *,
    which: Which = shutil.which,
    runner: Runner = subprocess.run,
    directory_exists: DirectoryExists = Path.is_dir,
) -> int:
    steps = COMMAND_STEPS[command]
    try:
        executables = resolve_tools(steps, which)
    except ToolNotFoundError as error:
        hint = INSTALL_HINTS[error.tool]
        print(
            f"{error.tool} was not found on PATH. {hint} before running {command}.",
            file=sys.stderr,
        )
        return 127

    if command == "check" and not check_dependencies_installed(directory_exists):
        return 1

    try:
        result = run_steps(steps, executables, runner)
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        return 130

    if command == "setup" and result == 0:
        print(
            "Setup complete. Environment files and optional Ollama models remain "
            "manual; see README.md."
        )
    return result


class WindowsJob:
    """Keep reload workers in a job even when their original parent exits."""

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong),
                ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD),
                ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t),
                ("active_processes", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits),
                ("io_counters", ctypes.c_ulonglong * 6),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
            "SetInformationJobObject": (
                [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD],
                wintypes.BOOL,
            ),
            "AssignProcessToJobObject": (
                [wintypes.HANDLE, wintypes.HANDLE],
                wintypes.BOOL,
            ),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes = arguments
            function.restype = result
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            error = ctypes.WinError(ctypes.get_last_error())
            self.close()
            raise error

    def add(self, process: subprocess.Popen[str]) -> None:
        import ctypes

        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def dev_log(message: str, *, error: bool = False) -> None:
    # A print can perform multiple writes; serialize complete prefixed lines.
    with OUTPUT_LOCK:
        print(message, file=sys.stderr if error else sys.stdout, flush=True)


def stream_output(name: str, process: subprocess.Popen[str]) -> None:
    assert process.stdout is not None
    with process.stdout:
        for line in process.stdout:
            dev_log(f"[{name}] {line.rstrip()}")


def stop_dev_processes(
    processes: Sequence[subprocess.Popen[str]], job: WindowsJob | None
) -> None:
    # Ignore additional Ctrl+C presses until both trees have been reaped.
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        for process in processes:
            try:
                if os.name == "nt":
                    if process.poll() is None:
                        process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except OSError as error:
                dev_log(f"[dev] Shutdown signal failed: {error}", error=True)

        deadline = time.monotonic() + 5
        for process in processes:
            try:
                process.wait(timeout=max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass

        if job is not None:
            # Also kills descendants of an already-exited uv/npm parent.
            job.close()
        for process in processes:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            elif process.poll() is None:
                # Fallback if assigning a newly spawned process to the job failed.
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            process.wait()
    finally:
        signal.signal(signal.SIGINT, previous)


def run_dev(*, which: Which = shutil.which, runner: Runner = subprocess.run) -> int:
    steps = BACKEND_STEPS + FRONTEND_STEPS
    try:
        executables = resolve_tools(steps, which)
    except ToolNotFoundError as error:
        print(
            f"[dev] {error.tool} was not found on PATH. {INSTALL_HINTS[error.tool]}; "
            "then run python scripts/dev.py setup.",
            file=sys.stderr,
        )
        return 127
    if not check_dependencies_installed():
        return 1
    if (
        not backend_python().is_file()
        or not (FRONTEND_DEPENDENCIES_DIR / "next/dist/bin/next").is_file()
    ):
        print(
            "[dev] Incomplete dependencies. Run python scripts/dev.py setup.",
            file=sys.stderr,
        )
        return 1

    processes: list[subprocess.Popen[str]] = []
    readers: list[threading.Thread] = []
    job = None
    label = "[dev]"
    try:
        ready, message = node_readiness(which, runner)
        if not ready:
            print(f"[frontend] {message}", file=sys.stderr)
            return 2
        result = runner(
            [str(backend_python()), "-c", BACKEND_IMPORT_PROBE],
            cwd=BACKEND_DIR,
            capture_output=True,
            text=True,
            timeout=30,
            shell=False,
        )
        if result.returncode:
            print(
                "[backend] Required imports failed. Run python scripts/dev.py setup.",
                file=sys.stderr,
            )
            return 1
        dev_log("[frontend] Frontend: http://localhost:3000")
        dev_log("[backend] Backend: http://localhost:8000")
        dev_log("[backend] API health: http://localhost:8000/health")
        dev_log("[dev] Press Ctrl+C to stop both servers.")
        if os.name == "nt":
            job = WindowsJob()
        for name, step in zip(("backend", "frontend"), steps, strict=True):
            label = step.label
            dev_log(label)
            options = (
                {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
                if os.name == "nt"
                else {"start_new_session": True}
            )
            process = subprocess.Popen(
                [executables[step.tool], *step.arguments],
                cwd=step.cwd,
                shell=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                bufsize=1,
                **options,
            )
            processes.append(process)
            if job is not None:
                job.add(process)
            reader = threading.Thread(
                target=stream_output, args=(name, process), daemon=True
            )
            reader.start()
            readers.append(reader)
        while True:
            for step, process in zip(steps, processes, strict=True):
                code = process.poll()
                if code is not None:
                    dev_log(
                        f"{step.label} exited unexpectedly with exit code {code}; "
                        "stopping both servers.",
                        error=True,
                    )
                    return code if code > 0 else (128 - code if code < 0 else 1)
            time.sleep(0.1)
    except KeyboardInterrupt:
        dev_log("\n[dev] Interrupted; stopping both servers.", error=True)
        return 130
    except (OSError, subprocess.TimeoutExpired) as error:
        dev_log(
            f"{label} failed: {error}. Run python scripts/dev.py setup "
            "if dependencies are missing.",
            error=True,
        )
        return 1
    finally:
        stop_dev_processes(processes, job)
        for reader in readers:
            reader.join(timeout=2)
        # Assignment to a Windows job can fail before a reader takes ownership.
        for process in processes[len(readers) :]:
            if process.stdout is not None:
                process.stdout.close()


def main(argv: Sequence[str] | None = None) -> int:
    if sys.version_info < MINIMUM_PYTHON:
        required = ".".join(str(part) for part in MINIMUM_PYTHON)
        print(f"Python {required} or newer is required.", file=sys.stderr)
        return 2

    arguments = build_parser().parse_args(argv)
    if arguments.command == "dev":
        return run_dev()
    if arguments.command == "doctor":
        return run_doctor(arguments)
    if arguments.command == "benchmark-catalog":
        return run_benchmark(arguments)
    if arguments.command in ("setup", "check", "check-clean", "frontend"):
        ready, message = node_readiness()
        if not ready:
            print(message, file=sys.stderr)
            return 2
    if arguments.command == "backend" and not backend_python().is_file():
        print(
            "Backend dependencies are not installed. Run python scripts/dev.py setup.",
            file=sys.stderr,
        )
        return 1
    return run_command(arguments.command)


if __name__ == "__main__":
    raise SystemExit(main())
