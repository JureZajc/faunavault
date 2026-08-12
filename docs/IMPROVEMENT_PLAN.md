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
| Startup normalization ran outside migration completion tracking | Earlier migrations could be recorded before `normalize_existing_domestic_metadata()` ran, allowing an interrupted startup to skip normalization permanently | Inconsistent legacy metadata after a crash | Make normalization migration 5 and record it only after the idempotent normalization succeeds | Implemented through the versioned migration runner; failed/interrupted normalization remains pending and is retried |

## P1 — Maintainability and reliability

| Finding | Evidence | Impact | Solution | Scope / risks |
| --- | --- | --- | --- | --- |
| Backend application is a 1,400+ line module | Models, config, migrations, images, AI, taxonomy, albums, and routes shared `app/main.py` | High coupling and difficult isolated testing | Extract settings, models, schemas, migrations, and domain services | Implemented for album, catalog, classification, photo lifecycle, taxonomy/GBIF, and Animal routing. GBIF HTTP behavior now has a closeable client boundary; taxonomy search, persistence, assignment, and reconciliation have cohesive service ownership and deterministic fake-client tests. |
| Configuration was scattered | Custom `.env` parsing and direct `os.getenv()` calls existed in multiple modules | Inconsistent defaults and hard-to-test configuration | Centralize settings with `pydantic-settings` | Implemented |
| Classification state is not durable | Only `pending`, `classified`, and `needs_review` were stored; running/failure progress lived in browser memory | Interrupted jobs and failures were difficult to understand or retry | Add persistent local classification jobs and provenance | Implemented with migration 6, a serial in-process worker, polling, safe retry, restart recovery, and model provenance |
| Lifecycle behavior lacked tests | Existing backend tests covered taxonomy/albums and animal naming only | Regressions could cause data loss | Add isolated upload, duplicate, Trash, purge, and migration coverage | Implemented, including upload flush/commit failures, batch recovery, filesystem and database purge failures, interrupted purge recovery, and migration retry behavior |
| Dependency advisories need review | The 2026-08-12 review confirmed eight npm affected-package findings and identified Pillow 12.2.0 security fixes | Production and development/build exposure was classified separately | Apply targeted Next.js, Tailwind, transitive lockfile, and Pillow patch/minor upgrades | Implemented/resolved; final live npm audits report zero findings, Pillow is 12.3.0, and the evidence and exposure assessment are recorded in `docs/DEPENDENCY_SECURITY_REVIEW.md` |

## P2 — High-value product improvements

| Finding | Evidence | Impact | Solution | Dependencies / risks |
| --- | --- | --- | --- | --- |
| Main catalog loads every photo | `GET /photos` returns a complete list and the former List implementation filtered it locally | Increasing latency and memory use for thousands of photos | Add a separate paginated catalog endpoint with backend search/status/category/taxonomy filters; retain `GET /photos` compatibility | Implemented with SQL-backed `/catalog/photos`, bounded lazy `/catalog/taxa` options, deterministic sorting, and URL-restorable List state. Generated 120,000-row SQLite plans verified the migration 7 active/status/category indexes avoid scans and temporary sorts on their target paths; substring search remains scan-based. |
| Album pagination happens after loading all records | Album grouping loads all animals, photos, and taxa before slicing | Album requests scale poorly | Replace in-memory aggregation with query-level counts and pagination | Implemented with SQL-backed verified/legacy grouping, counts, filters, Unicode search, deterministic covers/sorts, direct detail pagination, and bounded reconciliation discovery |
| AI calls are long synchronous requests | Each UI classification waited for an Ollama HTTP request | Refreshes lost progress; batch runs were fragile | Add a lightweight SQLite-backed job queue and polling | Implemented; retained classification URLs now return asynchronous HTTP 202 job resources |
| Only exact duplicates are detected | SHA-256 catches identical bytes, not resized/re-encoded copies | Visually identical files may accumulate | Add optional perceptual hashes with explicit user confirmation | Implemented with Pillow-only `phash64-v1`, conservative distance `<= 4`, exact-first enforcement, active/Trash candidates, explicit per-file Keep both review, ID-based previews, and throttled resumable migration-9 backfill; no automatic merge or deletion |
| Backup is manual | Data spans SQLite plus an external image root | Recovery requires careful coordination | Add verified archive manifests and non-destructive backup tooling | Implemented with cold local backup creation, versioned manifests, SHA-256 payload verification, SQLite/archive consistency checks, atomic publication, standalone verification, and documented manual restore; automated restore remains deferred |

## P3 — Polish

- Frontend component-boundary decomposition is implemented: the catalog and photo-detail clients now retain route-level orchestration while focused local hooks/components own URL query state, uploads and duplicate review, catalog rendering, photo loading, metadata editing, linked-animal/taxonomy presentation, classification controls, lightbox state, and the detail Trash confirmation. No global state or data-fetching library was added, and behavior is covered by 59 frontend interaction tests.
- Dialog/lightbox accessibility hardening is implemented across duplicate review, Move to Trash, permanent delete, photo-detail confirmation, and the photo lightbox, including modal semantics, safe initial focus, dynamic focus traps, Escape/busy-state handling, focus restoration, reference-counted scroll locking, and interaction tests.
- Richer per-file batch upload progress is implemented with a sequential frontend queue, truthful Waiting/Uploading/Uploaded/Exact duplicate/Possible duplicate/Failed states, independent mixed results, and per-file transient retries. The initial queue continues past failures and possible duplicates, then perceptual reviews proceed independently; catalog refreshes are batched after the initial pass and after review completion. The compatibility batch API remains available, and byte-level percentages are not claimed.
- Replace remaining dense one-line JSX and review responsive controls on small screens.
- Add optional root developer commands after Windows and cross-platform behavior is agreed.

## Deliberately not implemented in this slice

- Cloud services, authentication, telemetry, external queues, Redis, Celery, or deployment workflows.
- Automatic Trash expiration, destructive restore automation, scheduled/remote/incremental backup management, perceptual clustering/search, or legacy-record deduplication.
- A breaking change to `GET /photos`, a full catalog rewrite, or a framework/global-state migration.
- A broad WCAG audit, application-wide keyboard navigation, color-contrast redesign, and screen-reader optimization outside modal interaction surfaces.

