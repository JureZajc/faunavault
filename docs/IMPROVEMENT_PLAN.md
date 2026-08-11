# FaunaVault Engineering Improvement Plan

Audit date: 2026-08-11

## Baseline

- The inspected archive contained 18 photo records and matching original, resized, and thumbnail files. SQLite reported `integrity_check: ok`, no foreign-key violations, no missing variants, no orphan variants, and no exact duplicate originals.
- Backend baseline: 10 tests passed and Ruff lint passed. Ruff format reported two unformatted modules.
- Frontend baseline: 11 tests, ESLint, TypeScript, and the Next.js production build passed. `npm ci` reported one moderate and seven high dependency advisories.
- There was no GitHub Actions workflow. The backend package description and frontend README were placeholders.

## P0 — Data safety and correctness

| Finding | Evidence | Impact | Solution | Scope / risks |
| --- | --- | --- | --- | --- |
| Migration backup could target the wrong database | Runtime connections used `DATABASE_URL`, while backup/storage setup used a fixed `backend/data/faunavault.db` path | A custom database could be migrated without the intended backup | Resolve the SQLite path from the engine URL and create timestamped online backups before pending migrations | Implemented; relative URLs now resolve against `backend` to preserve the documented path independently of process CWD |
| Upload commit failures could orphan files | Variants were written before `session.commit()` with no compensation around flush/commit | Database and filesystem could disagree | Stage validated files, promote them as one lifecycle operation, rollback and remove all promoted files on DB errors | Implemented; local single-process upload lock also closes duplicate races inside the supported runtime |
| Permanent deletion removed files before committing the row deletion | Any filesystem or commit failure could leave a live row with missing variants | Irrecoverable photo loss | Normal deletion is now soft deletion; permanent deletion uses a same-filesystem staging journal with startup recovery | Implemented; no automatic Trash purge |
| Startup normalization ran on every launch outside migration history | `normalize_existing_domestic_metadata()` scanned and potentially changed all photos every startup | Repeated expensive work and unaudited data changes | Run normalization only as part of a recorded migration batch | Implemented through the versioned migration runner |

## P1 — Maintainability and reliability

| Finding | Evidence | Impact | Solution | Scope / risks |
| --- | --- | --- | --- | --- |
| Backend application is a 1,400+ line module | Models, config, migrations, images, AI, taxonomy, albums, and routes shared `app/main.py` | High coupling and difficult isolated testing | Extract settings, models, schemas, migrations, and photo lifecycle services first | First slice implemented; taxonomy/GBIF/router extraction remains |
| Configuration was scattered | Custom `.env` parsing and direct `os.getenv()` calls existed in multiple modules | Inconsistent defaults and hard-to-test configuration | Centralize settings with `pydantic-settings` | Implemented |
| Classification state is not durable | Only `pending`, `classified`, and `needs_review` are stored; running/failure progress lives in browser memory | Interrupted jobs and failures are difficult to understand or retry | Add persistent local classification jobs and provenance | Deferred; requires a coherent follow-up slice |
| Lifecycle behavior lacked tests | Existing backend tests covered taxonomy/albums and animal naming only | Regressions could cause data loss | Add isolated upload, duplicate, Trash, purge, and migration coverage | First lifecycle suite implemented; more fault-injection coverage remains useful |
| Dependency advisories need review | `npm ci` reported eight advisories | Potential development/build-chain exposure | Review each advisory and upgrade deliberately | Deferred; do not use forced upgrades without compatibility validation |

## P2 — High-value product improvements

| Finding | Evidence | Impact | Solution | Dependencies / risks |
| --- | --- | --- | --- | --- |
| Main catalog loads every photo | `GET /photos` returns a complete list and `page.tsx` filters it locally | Increasing latency and memory use for thousands of photos | Add a separate paginated catalog endpoint with backend search/status/category/taxonomy filters; retain `GET /photos` compatibility | Requires catalog/frontend slice and URL-state design |
| Album pagination happens after loading all records | Album grouping loads all animals, photos, and taxa before slicing | Album requests scale poorly | Replace in-memory aggregation with query-level counts and pagination | Must preserve legacy/verified grouping semantics |
| AI calls are long synchronous requests | Each UI classification waits for an Ollama HTTP request | Refreshes lose progress; batch runs are fragile | Add a lightweight SQLite-backed job queue and polling | No Redis/Celery; single local worker only |
| Only exact duplicates are detected | SHA-256 catches identical bytes, not resized/re-encoded copies | Visually identical files may accumulate | Add optional perceptual hashes with explicit user confirmation | Must not silently merge records |
| Backup is manual | Data spans SQLite plus an external image root | Recovery requires careful coordination | Add verified archive manifests and non-destructive backup tooling | Automated restore remains high risk and should require explicit confirmation |

## P3 — Polish

- Split the large catalog and photo-detail client components into focused hooks/components without adding a global state library.
- Improve focus trapping/restoration for all dialogs and the lightbox.
- Add richer per-file batch upload progress and persistent classification progress.
- Replace remaining dense one-line JSX and review responsive controls on small screens.
- Add optional root developer commands after Windows and cross-platform behavior is agreed.

## Deliberately not implemented in this slice

- Cloud services, authentication, telemetry, external queues, Redis, Celery, or deployment workflows.
- Automatic Trash expiration, perceptual duplicate matching, destructive restore automation, or legacy-record deduplication.
- A breaking change to `GET /photos`, a full catalog rewrite, or a framework/global-state migration.

