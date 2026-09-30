"""Application version from the project manifest or its installed metadata."""

from importlib.metadata import version
from pathlib import Path
from tomllib import loads


def application_version() -> str:
    manifest = Path(__file__).resolve().parents[1] / "pyproject.toml"
    if manifest.is_file():
        return loads(manifest.read_text(encoding="utf-8"))["project"]["version"]
    return version("backend")


APP_VERSION = application_version()
