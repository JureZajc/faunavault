"""Disposable E2E server; additional test port origins never affect production."""

import os
import sys
import tempfile
from pathlib import Path

import uvicorn
from fastapi.middleware.cors import CORSMiddleware

root = Path(os.environ["FAUNAVAULT_E2E_ROOT"]).resolve()
if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith(
    "faunavault-e2e-"
):
    raise RuntimeError("Refusing to start E2E server outside disposable storage")
backend_port = int(os.environ.get("FAUNAVAULT_E2E_BACKEND_PORT", "8001"))
frontend_port = int(os.environ.get("FAUNAVAULT_E2E_FRONTEND_PORT", "3001"))
if not all(1024 <= port <= 65535 for port in (backend_port, frontend_port)):
    raise RuntimeError("Invalid E2E port")

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from app.main import app, settings  # noqa: E402

if (
    settings.database_path.resolve() != root / "data" / "faunavault.db"
    or settings.image_dir.resolve() != root / "images"
):
    raise RuntimeError("Refusing to start E2E server against non-disposable storage")
if frontend_port not in (3000, 3001):
    for middleware in app.user_middleware:
        if middleware.cls is CORSMiddleware:
            middleware.kwargs["allow_origins"] = [
                f"http://{host}:{frontend_port}" for host in ("localhost", "127.0.0.1")
            ]

uvicorn.run(app, host="127.0.0.1", port=backend_port)
