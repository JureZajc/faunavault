"""Small, cross-platform developer workflow commands for FaunaVault."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

MINIMUM_PYTHON = (3, 12)
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = REPOSITORY_ROOT / "backend"
FRONTEND_DIR = REPOSITORY_ROOT / "frontend"
BACKEND_ENV_DIR = BACKEND_DIR / ".venv"
FRONTEND_DEPENDENCIES_DIR = FRONTEND_DIR / "node_modules"


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
    probe = (
        "import sys; "
        "assert sys.version_info >= (3, 12), 'Backend requires Python 3.12+'; "
        "import fastapi, httpx, PIL, pillow_heif, pydantic_settings, dotenv, multipart, sqlmodel, uvicorn"
    )
    try:
        result = runner(
            [str(interpreter), "-c", probe],
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


def main(argv: Sequence[str] | None = None) -> int:
    if sys.version_info < MINIMUM_PYTHON:
        required = ".".join(str(part) for part in MINIMUM_PYTHON)
        print(f"Python {required} or newer is required.", file=sys.stderr)
        return 2

    arguments = build_parser().parse_args(argv)
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
