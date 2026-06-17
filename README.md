# FaunaVault

FaunaVault is a local-first AI animal photo archive. The MVP lets you upload animal photos, stores the image files on disk, creates resized images and thumbnails, keeps searchable metadata in SQLite, and presents the collection in a clean visual catalog.

The project is designed to keep personal photo collections on the user's machine. Images are not stored in the database and no cloud storage or authentication is included in this MVP.

## Stack

- Backend: Python, FastAPI, SQLModel, SQLite, Pillow, uv
- Frontend: Next.js App Router, TypeScript, Tailwind CSS
- Local image storage: `/mnt/e/FaunaVault/data/images`
- Database: `backend/data/faunavault.db`

## Current MVP Features

- Upload `jpg`, `jpeg`, `png`, and `webp` animal photos
- Store originals under `/mnt/e/FaunaVault/data/images/original`
- Generate resized images under `/mnt/e/FaunaVault/data/images/resized`
- Generate thumbnails under `/mnt/e/FaunaVault/data/images/thumbs`
- Save photo metadata in SQLite
- Browse photos in a responsive visual catalog grid
- Filter by `pending`, `classified`, and `needs_review`
- View a detail page with larger image and metadata
- Run mock classification that fills in sample animal metadata
- Run local Ollama vision classification against photos stored on disk

## Backend Setup

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

The API runs at `http://localhost:8000`.

Useful endpoints:

- `GET /health`
- `POST /photos/upload`
- `GET /photos`
- `GET /photos/{photo_id}`
- `POST /photos/{photo_id}/classify`
- `POST /photos/{photo_id}/mock-classify`
- `GET /images/{image_type}/{filename}`

Backend environment variables:

```bash
OLLAMA_BASE_URL=http://localhost:11434
AI_PRIMARY_MODEL=qwen3-vl:8b
AI_FALLBACK_MODEL=gemma4:12b
AI_CONFIDENCE_THRESHOLD=0.65
```

## Frontend Setup

Create `frontend/.env.local` if needed:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Run the app:

```bash
cd frontend
npm install
npm run dev
```

The frontend runs at `http://localhost:3000`.

## Local AI Classification

FaunaVault can classify images with local Ollama vision models. Pull the primary model:

```bash
ollama pull qwen3-vl:8b
```

Optionally pull the fallback model:

```bash
ollama pull gemma4:12b
```

Check that Ollama is running:

```bash
curl http://localhost:11434/api/tags
```

If the backend runs in WSL and Ollama runs on Windows, `localhost` inside WSL may not reach the Windows Ollama service. In PowerShell, verify Windows can see Ollama:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:11434/api/tags
```

If Windows can reach Ollama but WSL cannot, stop Ollama, start it with a host WSL can reach, and point the backend at the WSL gateway:

```powershell
$env:OLLAMA_HOST = "0.0.0.0:11434"
ollama serve
```

```bash
export OLLAMA_BASE_URL=http://$(awk '/nameserver/ {print $2; exit}' /etc/resolv.conf):11434
cd backend
uv run uvicorn app.main:app --reload
```

When you click **Run local AI classification** on a photo detail page, the backend reads the resized image from `/mnt/e/FaunaVault/data/images/resized` if available, otherwise the original image from `/mnt/e/FaunaVault/data/images/original`. It sends the image as base64 to the local Ollama server and asks for structured animal metadata. If the primary model returns a low-confidence result or fails, the backend tries the fallback model.

On a valid model response, FaunaVault updates the photo metadata and marks it `classified` when confidence is at or above `AI_CONFIDENCE_THRESHOLD`; otherwise it marks the photo `needs_review`. If the model output cannot be parsed as valid JSON, the API returns a clear error and leaves existing metadata unchanged.

Images stay on your machine. They are read from local disk and sent only to the local Ollama service configured by `OLLAMA_BASE_URL`. The `/photos/{photo_id}/mock-classify` endpoint remains available for testing the UI and database flow without running a model.
