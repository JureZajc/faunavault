# FaunaVault

FaunaVault is a local-first AI animal photo archive for organizing animal images on a Windows machine. It stores photo files on disk, keeps metadata in a local SQLite database, and shows the collection as a visual catalog with detail pages. AI classification runs through local Ollama, so no cloud storage is required.

Images are stored locally under `E:/FaunaVault/data/images`, metadata is stored locally in `backend/data/faunavault.db`, and the backend talks to Ollama at `http://localhost:11434`. WSL was used earlier during development, but the documented runtime below is Windows only.

## Current Features

- Image upload
- Local original, resized, and thumbnail image storage
- Visual catalog view
- Photo detail page
- Mock classification for testing
- Local Ollama classification
- Delete photo and related image files

## Tech Stack

- Frontend: Next.js, TypeScript, Tailwind CSS
- Backend: FastAPI, Python, uv, SQLModel
- Database: SQLite
- Image processing: Pillow
- AI: Ollama with `qwen3-vl:8b` and `gemma4:e4b` fallback
- Storage: local filesystem

## Windows Setup

Open PowerShell from the project root.

Check `uv`:

```powershell
uv --version
```

If `uv` is missing, install uv for Windows from the official uv installation instructions, then open a new PowerShell window and check again.

Check Node.js and npm:

```powershell
node --version
npm --version
```

Check Ollama:

```powershell
ollama list
curl http://localhost:11434/api/tags
```

Pull the primary vision model:

```powershell
ollama pull qwen3-vl:8b
```

The configured fallback model is `gemma4:e4b`.

Create the local image folders:

```powershell
New-Item -ItemType Directory -Force E:/FaunaVault/data/images/original
New-Item -ItemType Directory -Force E:/FaunaVault/data/images/resized
New-Item -ItemType Directory -Force E:/FaunaVault/data/images/thumbs
```

## Environment Configuration

Example files are included for local setup:

- Root example: `.env.example`
- Backend example: `backend/.env.example`
- Frontend example: `frontend/.env.local.example`

Do not commit real local config files such as `backend/.env` or `frontend/.env.local`.

Backend values:

```env
DATA_DIR=E:/FaunaVault/data
IMAGE_DIR=E:/FaunaVault/data/images
DATABASE_URL=sqlite:///./data/faunavault.db
OLLAMA_BASE_URL=http://localhost:11434
AI_PRIMARY_MODEL=qwen3-vl:8b
AI_FALLBACK_MODEL=gemma4:e4b
AI_CONFIDENCE_THRESHOLD=0.65
```

Frontend value:

```env
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Run The Backend

```powershell
cd backend
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Run The Frontend

In a second PowerShell window from the project root:

```powershell
cd frontend
npm install
npm run dev
```

## Browser URLs

- Frontend: [http://localhost:3000](http://localhost:3000/)
- Backend health: [http://localhost:8000/health](http://localhost:8000/health)
- Ollama tags: [http://localhost:11434/api/tags](http://localhost:11434/api/tags)

## Future Ideas

- Manual metadata correction
- Category filters
- Search
- Duplicate detection
- Docker support later
