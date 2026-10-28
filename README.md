# FaunaVault

FaunaVault is a local-first animal photo archive for one person on one machine.
Original photos and previews stay on your filesystem, metadata lives in SQLite,
and optional AI classification runs through local Ollama vision models.

Current `master` is **v0.3.0.dev0** (unreleased development). The latest published
source-based release is **v0.2.0**. [Release notes](CHANGELOG.md) ·
[MIT license](LICENSE)

![FaunaVault album view](faunavault-album-desktop.png)

## Key features

- JPEG, PNG, WebP, HEIC, and HEIF uploads; recursive local folder import.
- Recent Imports groups each browser selection or folder invocation, with live
  progress and View imported photos / Cull this import actions. **Create Trip/Event**
  offers editable camera-local capture-date recommendations, then opens the scoped
  List for explicit photo selection and confirmation (up to 250 per request).
  Unknown dates require manual entry; creating an Event never assigns photos.
  [Import Sessions guide](docs/OPERATIONS.md#import-sessions-and-recent-imports-v03).
- Untouched originals, local previews, capture/camera metadata, and GPS extraction.
- **Export selected** downloads up to 250 explicitly selected originals as a
  verified ZIP, with an optional JSON metadata manifest and size estimate.
  Selection and URL filters stay intact. [Selected export guide](docs/OPERATIONS.md#selected-photo-zip-export).
- Individual capture date/time, UTC offset, and GPS corrections, with retained
  extracted values and Restore original metadata. [Editing guide](docs/OPERATIONS.md#editable-capture-metadata-v02).
- Interactive GPS picker: in **Edit metadata**, choose **Choose on map**, click/tap
  a point or drag the existing marker, then **Use this location** and **Save**.
  In bulk **Edit capture / GPS → Set GPS coordinates**, choose one location,
  preview, confirm, and apply. Editable latitude/longitude remain available offline;
  loading maps may contact the configured external tile provider (OpenStreetMap).
- Bulk **Edit capture / GPS** for up to 250 selected photos: shift camera-local
  time, set date/time with preserved, specific or unknown offsets, set/remove GPS,
  clear capture time, or independently restore capture/GPS from verified originals.
  Unlike individual editing, every bulk operation requires a read-only before/after
  preview and confirmation. Apply is atomic; missing times and stale previews block
  changes. Intentional clears retain provenance and prevent EXIF backfills from
  repopulating values. Original bytes and AI decisions are preserved.
  [Bulk metadata guide](docs/OPERATIONS.md#bulk-capture-and-gps-editing).
- Search, filters, sorting, Timeline, clustered Map, species Albums, manual
  Collections, and live Smart Collections.
- Wildlife Insights summarizes active photos, verified species, capture activity,
  categories, classification, curation, and GPS coverage, with year filters and
  direct List/Map navigation. [Metric definitions and limits](docs/OPERATIONS.md#wildlife-insights).
- Trips & Events group explicitly selected Photos around dated experiences, with
  date suggestions, List/Map/Culling entry, custom cover Photos, and safe membership removal.
  Choose **Set as cover** on a member Photo or **Remove custom cover** to use
  the newest active member. Trash temporarily hides a custom cover; Restore
  reactivates it. Membership removal and permanent deletion clear the choice.
  [Trips & Events guide](docs/OPERATIONS.md#trips--events-v03).
- URL-restorable Map filters and compatible List navigation.
  [Map guide](docs/OPERATIONS.md#map-filters-and-list-navigation).
- Personal Favorites and 1–5-star Ratings, with List filters, rating sorting,
  Smart Collection criteria, and bulk actions. [Curation guide](docs/OPERATIONS.md#photo-favorites-and-ratings).
- Photo Culling with independent Pick / Reject decisions, sequential review,
  keyboard shortcuts, List filters, Smart Collections, and explicit bulk actions.
  [Culling guide](docs/OPERATIONS.md#photo-culling-v03).
- Two-photo Compare from List selection, Duplicate Review, or Culling, with
  independent zoom/pan, explicit original inspection, and shared curation.
  See the [Compare guide](docs/OPERATIONS.md#photo-compare-v03).
- Review rejected Photos through List, inspect or Compare, and explicitly select
  still-rejected Photos for recoverable Trash. Restore returns them to review.
  [Cleanup guide](docs/OPERATIONS.md#rejected-photo-review-and-cleanup-v03).
- Explicit cross-page selection for bulk tags, category, Collections, Trips & Events, curation,
  and recoverable Trash.
- SHA-256 exact duplicate protection and conservative visual duplicate review.
- Duplicate Review Center for archive curation, persistent Keep both decisions,
  and recoverable Trash actions; explicit local scans discover existing pairs.
- Optional durable AI classification jobs, confidence-based Review Inbox,
  manual editing, and local taxonomy with GBIF lookup.
- **Fullscreen gallery & slideshow** in manual Collections and Trips & Events: open from the header or a Photo, navigate with arrows, and explicitly Play at 3, 5 (default), or 10 seconds. Galleries load bounded pages independently of the grid; Species Album viewers share the slideshow controls. See [gallery controls](docs/OPERATIONS.md#fullscreen-gallery-and-slideshow).
- Manual Collections have large cover cards and header previews. Choose **Set as cover**
  on an active member, or **Remove custom cover** to use the newest active member
  (creation timestamp, then ID). Trash preserves the choice for Restore; removing
  membership or permanently deleting the Photo clears it. Empty Collections show a placeholder.
- Recoverable Trash, confirmed permanent deletion, archive diagnostics,
  verified cold backups, isolated recovery rehearsal, and portable metadata export.

## Requirements

Install [Python](https://www.python.org/downloads/) **3.12+**,
[uv](https://docs.astral.sh/uv/getting-started/installation/), and
[Node.js](https://nodejs.org/) **24+** with npm. Git is used to obtain/update the
source; it is not required by the running application. Dependencies include the
local HEIC/HEIF codec; no system codec is required.

[Ollama](https://ollama.com/) and a vision model are needed only for AI
classification. Browser tests additionally require Playwright Chromium.

## Quick Start

From PowerShell or a Unix-like shell:

```sh
git clone https://github.com/JureZajc/faunavault.git
cd faunavault
python scripts/dev.py setup
python scripts/dev.py doctor
```

Use `python3` instead of `python` on systems where it exposes Python 3.12+.
`setup` installs locked backend/frontend dependencies. It does not start services,
create environment files, initialize your archive, or download AI models.

No configuration is required for local defaults: SQLite at
`backend/data/faunavault.db`, images at `backend/data/images`, and the backend API
at `http://localhost:8000`. Missing storage before first startup is expected.
For custom paths, copy/edit `backend/.env.example` and
`frontend/.env.local.example` to their non-example names. Backend settings read
`backend/.env`; a root `.env` is not consumed. See
[configuration and upgrade safety](docs/OPERATIONS.md#configuration-and-initialization).

## Starting FaunaVault

The recommended development startup runs both servers in one terminal from the
repository root:

```sh
python scripts/dev.py dev
```

Backend and frontend logs use `[backend]` and `[frontend]` prefixes. Both servers
keep hot reload enabled. Press Ctrl+C once to stop both servers and their workers.
If either server exits, the command reports its exit code and stops the other.
Backend reload watches only `backend/app`; edits to tests or archive files do not
restart it. On Windows, the backend uses a separate hidden console so reload
signals cannot interrupt the launcher or frontend. The standalone `backend`
command uses the same reload and shutdown handling.
`dev` checks installed dependencies without reinstalling them; if setup is missing
or incomplete, run `python scripts/dev.py setup` first.

Alternatively, start individual services in two separate terminals:

```sh
python scripts/dev.py backend
```

```sh
python scripts/dev.py frontend
```

Open [FaunaVault](http://localhost:3000). The backend listens on localhost and
initializes the database/directories and applies migrations on startup. Existing
archives are upgraded without a reset. [Health](http://localhost:8000/health)
reports status and application version. When running services separately, stop
each server with Ctrl+C.

Both services are **localhost-only by default**: the frontend (development and
production) binds to `127.0.0.1:3000`, and the backend binds to `127.0.0.1:8000`.
Use `localhost` or `127.0.0.1` in your browser on the same machine.

FaunaVault has no authentication and is not intended for public internet exposure.
Access from another device requires explicit, deliberate configuration of server
bind addresses and the frontend API URL/backend CORS origins. Loopback binding
does not replace authentication or other protections if you intentionally deploy
FaunaVault on a network; configure those protections before exposing your archive.

For an existing archive using old implicit E-drive image storage, explicitly set
`IMAGE_DIR` to its existing root before upgrading. Startup refuses a populated
database paired with empty implicit portable originals; it never moves your data.

After stopping the backend, run `python scripts/dev.py doctor --archive` for a
full integrity scan. Plain `doctor` checks setup without scanning images or
contacting Ollama. [Diagnostics details](docs/OPERATIONS.md#setup-diagnostics).

## Importing an existing photo archive

Start the backend once to initialize/migrate storage, then stop it. From `backend`:

```powershell
uv run --no-sync faunavault-import "E:\Photos\Wildlife" --recursive --dry-run
uv run --no-sync faunavault-import "E:\Photos\Wildlife" --recursive
```

Unix example:

```sh
uv run --no-sync faunavault-import ~/Pictures/Wildlife --recursive --dry-run
uv run --no-sync faunavault-import ~/Pictures/Wildlife --recursive
```

Source files are never moved, renamed, or changed. Exact duplicates, including
Trash, are skipped; possible visual duplicates are skipped unless explicitly
allowed. Restart the backend after import. See
[all importer flags and queue behavior](docs/OPERATIONS.md#import-a-local-photo-folder).

## AI classification

Normal archive functionality works without AI. Ollama analyzes a local resized
preview to suggest animal metadata; its results can be edited or accepted in
Review. Primary and fallback both default to `qwen3-vl:8b`.

Install/start Ollama separately and explicitly install the model when wanted:

```sh
ollama pull qwen3-vl:8b
python scripts/dev.py doctor --ollama
```

An empty archive starts without contacting Ollama or downloading/warming models.
Previously queued classification jobs resume normal processing after restart.
Jobs persist in SQLite; execution failures have explicit Retry, and low-confidence
results enter Review. Folder import `--classify` queues newly imported photos
for processing after backend restart. See
[classification/retry details](docs/OPERATIONS.md#local-ai-classification-jobs)
and [Review Inbox](docs/OPERATIONS.md#ai-review-inbox).

## Backup and recovery

Stop the backend for backup creation and archive maintenance. From `backend`:

```powershell
uv run --no-sync faunavault-backup create "E:\FaunaVaultBackups"
uv run --no-sync faunavault-backup verify "E:\FaunaVaultBackups\<backup-name>"
uv run --no-sync faunavault-backup rehearse "E:\FaunaVaultBackups\<backup-name>" "E:\FaunaVaultRehearsals\new-target"
```

On Unix, substitute existing local directories such as `~/FaunaVaultBackups`.
Creation requires an existing destination; rehearsal requires a nonexistent
target with an existing parent. Backups include active photos, Trash, previews,
and SQLite metadata. Rehearsal migrates an isolated copy and requires a healthy
archive doctor; it never replaces your live archive. Backup format v1 supports
schemas 9–21. Production restore remains manual.

Read the [complete backup/recovery guide](docs/OPERATIONS.md#backup-and-recovery)
before relying on a backup. [Metadata export](docs/OPERATIONS.md#portable-metadata-export)
is separately useful for inspection and portability; it is not a recovery backup.

## Development and release validation

```sh
python scripts/dev.py check
```

This runs backend lint/format checks and pytest, frontend lint/typecheck/Vitest,
and a production build. It includes isolated first-run/schema and backup/recovery
coverage. `check-clean` performs frozen backend sync and `npm ci` first. Stop the
frontend before `setup`/`check-clean` on Windows because native modules may be locked.

For the release browser gate, from `frontend`:

```sh
npx playwright install chromium
npm run test:e2e
```

The suite uses a production build and real backend with disposable storage and
dedicated ports 3001/8001. It never uses your archive or requires Ollama, GBIF,
or OpenStreetMap. Dependencies/Chromium need installation access; the test
workflows themselves do not require external services. The smoke build uses its
own API URL, so restart/rebuild normal frontend development afterward.

## Documentation

- [Operations, configuration, import, AI, maintenance, and recovery](docs/OPERATIONS.md)
- [Backend architecture and commands](backend/README.md)
- [Frontend architecture and browser testing](frontend/README.md)
- [Metadata export format](docs/METADATA_EXPORT_FORMAT.md)
- [Measured catalog scale and R5 results](docs/CATALOG_BENCHMARK.md)
- [Engineering baseline and deferred work](docs/IMPROVEMENT_PLAN.md)
- [Maintainer release procedure](docs/RELEASE.md)
- [v0.2.0 release readiness and prepared GitHub notes](docs/RELEASE_READINESS_V0.2.0.md)
- [Historical v0.1.0 readiness report](docs/RELEASE_READINESS.md)

## Current limitations

- One user, one machine, one backend process and classification worker; local
  SQLite/filesystem storage, no authentication or cloud sync. Keep access local.
- GBIF taxonomy lookup uses the network; local taxonomy remains useful when it
  fails. OpenStreetMap basemap tiles are remote; photo records stay local and
  markers remain available without tiles. The basemap is not offline.
- No desktop installer, automatic update, automated production restore, or
  backup scheduling/retention/encryption.
- HEIC/HEIF uses the primary still image and 8-bit previews; no HDR/gain-map/color
  fidelity guarantee, container-frame browser, editing/re-encoding, or AVIF support.
- Metadata depends on valid source tags; capture time never substitutes import
  time. Possible visual duplicates are hints, not proof.
- Benchmarks tested synthetic metadata at 1k, 10k, 50k, and 100k photos. R5 improved
  browsing/count access, but substring search still scans candidates: rare search
  measured about 534 ms and the slowest text case about 758 ms at 100k. These are
  warm-cache service timings on one machine, excluding browser rendering, image
  loading, and HTTP transport—not universal scale guarantees. See the benchmark guide.

The project uses the MIT license. The committed HEIC compatibility fixture
retains its [BSD-3-Clause notice](backend/tests/fixtures/heic/LICENSE.txt).

## Tag Explorer and exact tags

Open **Tags** (`/tags`) to search all tags on active photos, sort alphabetically or
by usage, and see distinct-tag and untagged-photo totals. Click a tag to open its
exact match in List. List supports multiple tags with **AND** semantics, removable
chips, a clear action, and **Photos without tags**. Filters persist in the URL and
browser history. `bird` does not match `birds`; tag matching preserves case and
trims whitespace just like existing photo and bulk tag edits. General text search
keeps its broader behavior and can be combined with exact tags.

Tag filters also work in Culling. Map explains its limitation and links back to
the filtered List. Exact tags and untagged are live catalog criteria: version-1
Smart Collections cannot save them. Clear tag filters before creating or updating
a Smart Collection. No database migration or new tagging storage is required.
