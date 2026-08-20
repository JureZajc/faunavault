"""Small, cross-platform developer workflow commands for FaunaVault."""

from __future__ import annotations

import argparse
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


@dataclass(frozen=True)
class Step:
    label: str
    tool: str
    arguments: tuple[str, ...]
    cwd: Path


SETUP_STEPS = (
    Step("[backend] sync", "uv", ("sync",), BACKEND_DIR),
    Step("[frontend] install", "npm", ("ci",), FRONTEND_DIR),
)

# Keep this sequence synchronized with .github/workflows/ci.yml.
CHECK_STEPS = (
    Step("[backend] sync", "uv", ("sync", "--frozen"), BACKEND_DIR),
    Step("[backend] ruff check", "uv", ("run", "ruff", "check", "."), BACKEND_DIR),
    Step(
        "[backend] ruff format",
        "uv",
        ("run", "ruff", "format", "--check", "."),
        BACKEND_DIR,
    ),
    Step("[backend] pytest", "uv", ("run", "pytest"), BACKEND_DIR),
    Step("[frontend] install", "npm", ("ci",), FRONTEND_DIR),
    Step("[frontend] lint", "npm", ("run", "lint"), FRONTEND_DIR),
    Step("[frontend] typecheck", "npm", ("run", "typecheck"), FRONTEND_DIR),
    Step("[frontend] test", "npm", ("test",), FRONTEND_DIR),
    Step("[frontend] build", "npm", ("run", "build"), FRONTEND_DIR),
)

BACKEND_STEPS = (
    Step(
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
        BACKEND_DIR,
    ),
)

FRONTEND_STEPS = (
    Step("[frontend] development server", "npm", ("run", "dev"), FRONTEND_DIR),
)

COMMAND_STEPS = {
    "setup": SETUP_STEPS,
    "check": CHECK_STEPS,
    "backend": BACKEND_STEPS,
    "frontend": FRONTEND_STEPS,
}

INSTALL_HINTS = {
    "uv": "Install uv",
    "npm": "Install Node.js 24+ and npm",
}

Which = Callable[[str], str | None]
Runner = Callable[..., subprocess.CompletedProcess[bytes]]


class ToolNotFoundError(Exception):
    def __init__(self, tool: str) -> None:
        self.tool = tool
        super().__init__(tool)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run common FaunaVault developer workflows from the repository root."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("setup", help="Install backend and frontend dependencies.")
    subparsers.add_parser(
        "check", help="Run the complete CI-equivalent validation sequence."
    )
    subparsers.add_parser("backend", help="Start the FastAPI development server.")
    subparsers.add_parser("frontend", help="Start the Next.js development server.")
    return parser


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
            return result.returncode
    return 0


def run_command(
    command: str,
    *,
    which: Which = shutil.which,
    runner: Runner = subprocess.run,
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
    return run_command(arguments.command)


if __name__ == "__main__":
    raise SystemExit(main())
