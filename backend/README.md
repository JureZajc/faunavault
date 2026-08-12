# FaunaVault backend

The FastAPI backend owns local SQLite metadata, image lifecycle operations, migrations, taxonomy behavior, and durable Ollama classification jobs. Run it from this directory with:

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

Classification is asynchronous and local-first. One lifespan-owned in-process worker claims SQLite jobs in `queued_at` order and processes them serially. Status and safe failures survive browser refresh and backend restart; interrupted running jobs are marked failed for explicit retry. The worker records requested/actual model, fallback use, attempt count, duration, and prompt version. FaunaVault supports one backend process, not multiple Uvicorn workers.

`POST /classification-jobs`, `GET /classification-jobs`, `GET /classification-jobs/{id}`, and `POST /classification-jobs/{id}/retry` are the canonical API. The retained `/photos/{id}/classify` and `/photos/classify-pending` URLs now return HTTP 202 job resources and no longer provide synchronous response contracts.

The scalable catalog API is `GET /catalog/photos`. It performs pagination,
search, status/category/verified-taxon filtering, deterministic sorting, total
counting, and small status/category facets in SQLite. Page size defaults to 48
and is capped at 100. `GET /catalog/taxa` provides bounded pages of stable local
taxon IDs with labels and active-photo counts for the List selector. The legacy
`GET /photos` response and semantics remain unchanged.
