# FaunaVault

FaunaVault is a local-first animal photo archive. Originals and derived images stay on your computer, metadata lives in SQLite, and optional AI classification runs through local Ollama vision models. GBIF taxonomy lookup is the only network-backed product integration and degrades to locally cached taxonomy when unavailable.

![FaunaVault album view](faunavault-album-desktop.png)

## Features

- Single and batch image upload with JPEG, PNG, and WebP content validation
- Exact duplicate detection using SHA-256, including duplicates currently in Trash
- Original, resized, and thumbnail variants with EXIF orientation handling
- Searchable/filterable photo catalog, species albums, animals, and GBIF taxonomy linking
- Durable SQLite-backed Ollama classification jobs with confidence-based review, provenance, retry, and manual metadata editing
- Recoverable Trash with restore and explicitly confirmed permanent deletion
- Versioned, backed-up SQLite migrations and local-only storage

## Catalog API and navigation

The main List view uses `GET /catalog/photos`, a backend-filtered page API with
48 items by default and a maximum page size of 100. It supports `page`,
`page_size`, `search`, `status`, `category`, `uncategorized`, `taxon_id`,
`sort`, and `order`. Responses include the filtered `total`, `total_pages`, and
small global status/category facets. Search is a case-insensitive SQLite
substring search across photo metadata, tags, animal names, and locally stored
taxonomy; whitespace-separated terms must all match somewhere in the record.

Verified taxon choices are loaded separately and in bounded pages from
`GET /catalog/taxa`. Each option uses the stable local `Taxon.id` and includes
its display label, scientific name, and active-photo count. The legacy
`GET /photos` endpoint remains unchanged and still returns the complete active
Photo array for compatible consumers.

List page, search, filters, sorting, verified taxon, and flat/grouped layout are
stored in URL search parameters. Refresh, copied URLs, browser Back/Forward,
and photo detail return navigation restore the same catalog context. Grouping
is intentionally page-local once pagination is active.

## Architecture and storage

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS
- Backend: FastAPI, Python 3.12+, SQLModel, SQLite, Pillow
- AI: local Ollama (`qwen3-vl:8b`, with `gemma4:e4b` fallback by default)

The default Windows configuration stores image files under `E:/FaunaVault/data/images` and SQLite metadata under `backend/data/faunavault.db`. Existing `.env` values take precedence; upgrades do not relocate data. Originals are preserved byte-for-byte. Resized and thumbnail files are reproducible derivatives.

Normal deletion only sets a deleted timestamp. Trash continues to reference the same local files. A photo must be moved to Trash before it can be permanently deleted. Permanent deletion stages variants in a private journal, commits the row deletion, and cleans the staged files; interrupted work is reconciled on the next backend startup.

## Local AI classification jobs

Classification requests are persisted in SQLite and processed serially by a lightweight worker inside the single FastAPI process. The browser does not need to stay open: queued and running state survives navigation and refresh, while completed and failed jobs remain visible with their model, duration, attempt count, and prompt version.

Jobs use `queued`, `running`, `succeeded`, and `failed` execution states. A succeeded result may still set the photo to `needs_review` when confidence is low or the model requests review; that is not an execution failure. Failed jobs require an explicit retry. Retry reuses the job, increments its attempt count, and refreshes `queued_at`, which is the FIFO queue-order timestamp.

The primary model runs first. The configured fallback runs once when the primary fails or produces low confidence; provenance identifies the actual accepted model. Connections time out after 10 seconds and classification requests after 120 seconds. Malformed model output and Ollama failures become safe failed jobs without overwriting photo metadata.

An unexpected backend stop marks any interrupted running job failed on restart with an explicit retry action; work is never silently repeated. Moving a photo to Trash fails queued/running work, and a delayed Ollama response cannot write metadata after Trash or a manual edit. Restoring the photo permits explicit retry but does not restart work automatically.

FaunaVault supports one local backend process and one classification worker. Do not run multiple Uvicorn workers; distributed worker coordination is deliberately out of scope.

The existing `POST /photos/{id}/classify` and `POST /photos/classify-pending` URLs are retained, but both now return asynchronous HTTP 202 job resources instead of synchronous Photo or batch-result bodies. There is no legacy synchronous Ollama classification route. The canonical resource API is `POST/GET /classification-jobs` plus `POST /classification-jobs/{id}/retry`.

## Windows setup

Install Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 24+, npm, and [Ollama](https://ollama.com/). From the repository root:

```powershell
cd backend
uv sync
ollama pull qwen3-vl:8b
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

In a second terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Backend health is available at [http://localhost:8000/health](http://localhost:8000/health).

## Configuration

Copy `backend/.env.example` and `frontend/.env.local.example` to their non-example names as needed. Important backend values:

```env
DATA_DIR=E:/FaunaVault/data
IMAGE_DIR=E:/FaunaVault/data/images
DATABASE_URL=sqlite:///./data/faunavault.db
OLLAMA_BASE_URL=http://localhost:11434
AI_PRIMARY_MODEL=qwen3-vl:8b
AI_FALLBACK_MODEL=gemma4:e4b
AI_CONFIDENCE_THRESHOLD=0.65
MAX_UPLOAD_BYTES=52428800
MAX_IMAGE_PIXELS=80000000
```

Frontend:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Validation

```powershell
cd backend
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
uv run pytest

cd ../frontend
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

## Backup and recovery

Use a cold backup for a consistent, easy-to-understand recovery point:

1. Stop the backend so no upload, edit, classification, migration, or Trash operation is running.
2. Copy the resolved SQLite database file shown by `DATABASE_URL`.
3. Copy the complete `IMAGE_DIR`, including hidden `.purge` data if an interrupted permanent deletion exists.
4. Store both copies together and record the date plus configured paths.

To restore, keep FaunaVault stopped, preserve the current database/image directory as a separate fallback, restore both members of the same backup set to their configured paths, then start the backend. Check the catalog, Trash, albums, and several original images before removing the fallback copy. Never restore only the database or only the image directory.

Before schema upgrades, FaunaVault creates timestamped SQLite backups next to the active database. Domestic metadata normalization is schema migration 5, so it is recorded only after successful normalization and safely retried if startup is interrupted. These backups supplement but do not replace full archive backups.

## Troubleshooting

- Ollama unavailable: verify `ollama list` and `curl http://localhost:11434/api/tags`, then retry the failed job.
- Duplicate response: open the referenced catalog photo or use “View Trash” and restore the deleted copy.
- Image rejected: confirm extension, MIME type, actual format, file size, and pixel dimensions agree with configured limits.
- Migration failure: keep the backend stopped and inspect the newest `*.pre-migrate-*.db` backup before retrying.

See [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md) for the audit and prioritized remaining work.
