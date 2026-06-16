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
- `POST /photos/{photo_id}/mock-classify`
- `GET /images/{image_type}/{filename}`

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

## Future AI Integration

Ollama is expected to provide local vision model inference in a later milestone. The current `/photos/{photo_id}/mock-classify` endpoint intentionally uses fixed sample metadata so the upload, storage, thumbnailing, database, and UI flows can be tested without adding model calls yet.
