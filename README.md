# FaunaVault

FaunaVault is a local-first animal photo archive. Originals and derived images stay on your computer, metadata lives in SQLite, and optional AI classification runs through local Ollama vision models. GBIF taxonomy lookup is the only network-backed product integration and degrades to locally cached taxonomy when unavailable.

![FaunaVault album view](faunavault-album-desktop.png)

## Features

- Single and batch image upload with JPEG, PNG, and WebP content validation
- Exact duplicate detection using SHA-256, including duplicates currently in Trash
- Original, resized, and thumbnail variants with EXIF orientation handling
- Searchable/filterable photo catalog, species albums, animals, and GBIF taxonomy linking
- Local Ollama classification with confidence-based review state and manual metadata editing
- Recoverable Trash with restore and explicitly confirmed permanent deletion
- Versioned, backed-up SQLite migrations and local-only storage

## Architecture and storage

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS
- Backend: FastAPI, Python 3.12+, SQLModel, SQLite, Pillow
- AI: local Ollama (`qwen3-vl:8b`, with `gemma4:e4b` fallback by default)

The default Windows configuration stores image files under `E:/FaunaVault/data/images` and SQLite metadata under `backend/data/faunavault.db`. Existing `.env` values take precedence; upgrades do not relocate data. Originals are preserved byte-for-byte. Resized and thumbnail files are reproducible derivatives.

Normal deletion only sets a deleted timestamp. Trash continues to reference the same local files. Permanent deletion stages variants in a private journal, commits the row deletion, and cleans the staged files; interrupted work is reconciled on the next backend startup.

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

Before schema upgrades, FaunaVault creates timestamped SQLite backups next to the active database. These supplement but do not replace full archive backups.

## Troubleshooting

- Ollama unavailable: verify `ollama list` and `curl http://localhost:11434/api/tags`.
- Duplicate response: open the referenced catalog photo or use “View Trash” and restore the deleted copy.
- Image rejected: confirm extension, MIME type, actual format, file size, and pixel dimensions agree with configured limits.
- Migration failure: keep the backend stopped and inspect the newest `*.pre-migrate-*.db` backup before retrying.

See [docs/IMPROVEMENT_PLAN.md](docs/IMPROVEMENT_PLAN.md) for the audit and prioritized remaining work.
