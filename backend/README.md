# FaunaVault backend

The FastAPI backend owns local SQLite metadata, image lifecycle operations, migrations, taxonomy behavior, and Ollama classification. Run it from this directory with:

```powershell
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

Validation:

```powershell
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

Configuration is loaded through `pydantic-settings` from `backend/.env`. Relative SQLite paths resolve against this directory. See the root README for storage, backup, migration, and recovery details.
