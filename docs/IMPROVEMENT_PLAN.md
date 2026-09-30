# FaunaVault Engineering Improvement Roadmap

Reviewed against `master` on 2026-08-23.

## Purpose

FaunaVault has completed its original engineering-hardening cycle. This document
keeps that history as a concise baseline and identifies only the next work that
has clear value for a local-first personal archive.

The current product is a single-user, single-machine application. SQLite owns
metadata and durable classification jobs, originals and reproducible derivatives
remain on local storage, Ollama is optional and local, and GBIF is the only
network-backed product integration. That boundary remains appropriate.

## Completed hardening baseline (P0-P4)

The 2026-08-11 audit originally organized work as P0-P3. Those findings are
closed, and the subsequent archive-health P4 slice is also complete:

- **Lifecycle and data safety:** migrations are versioned and preceded by SQLite
  backups; uploads compensate for database/filesystem failures; exact duplicates
  include Trash; normal deletion is recoverable; permanent deletion uses a
  startup-reconciled journal.
- **Archive integrity and recovery foundations:** backup format v1 creates cold,
  self-contained archives with a standalone verifier, checksums, schema and
  inventory checks, and a conservative manual-restore procedure. Read-only
  `doctor` covers the live archive, and dry-run-by-default `repair-derived`
  atomically rebuilds only missing or invalid derivatives from trusted originals.
- **Catalog, albums, and duplicates:** catalog and album reads are SQL-paginated,
  filtered, deterministically sorted, and supported by justified indexes. Exact
  SHA-256 and conservative perceptual duplicate detection both require safe,
  explicit user decisions.
- **Classification and taxonomy:** local Ollama work uses durable, retryable,
  serial SQLite jobs with provenance and restart handling. Taxonomy has a tested
  GBIF client boundary and retains useful local behavior when GBIF is unavailable.
- **Frontend and developer experience:** upload outcomes are per-file and
  truthful; catalog navigation is URL-restorable; Trash, modal, lightbox,
  responsive, and accessibility behavior has focused coverage; component
  boundaries and root setup/check/run commands are in place.
- **Security and validation:** the recorded dependency findings were remediated,
  GitHub Actions runs backend and frontend checks, and the current audit collected
  134 backend tests (132 passed, 2 platform-dependent skips) and passed all 62
  frontend interaction tests, lint, type checking, and the production build.

This summary replaces the old finding-by-finding completion log; it does not
reopen or discard the engineering decisions behind that work. Detailed behavior
remains documented in the [project README](../README.md),
[backend README](../backend/README.md), [frontend README](../frontend/README.md),
and [dependency security review](DEPENDENCY_SECURITY_REVIEW.md).

## Current architectural baseline

- The supported runtime is one FastAPI process with one in-process classification
  worker. Durable jobs remove the need for an external queue.
- SQLite, the image directories, and cold backup directories are the complete
  persistence boundary. Originals are authoritative; resized images and
  thumbnails are reproducible.
- Backup verification proves that a backup is internally complete, while live
  maintenance proves archive health. Production restore remains a documented,
  manual operation that preserves the current archive before replacement.
- Catalog text search is escaped, case-insensitive substring matching across
  photo, animal, and local taxonomy fields. Existing catalog and relationship
  indexes remain authoritative; leading-wildcard text search examines active
  candidates. The [catalog benchmark](CATALOG_BENCHMARK.md) now measures complete
  responses, counts/facets, saved queries, and actual query plans on disposable
  synthetic archives before further query changes.
- Frontend state is route-local or held in focused hooks. Durable work is restored
  from the backend; transient browser-only upload and dialog state is not treated
  as persistent application state.

## Current product feature: Classification Reliability v2

Local Ollama classification remains one serial, durable SQLite-backed worker,
but every model request now has an explicit runtime boundary. Settings provide a
5-second connect timeout, 180-second response timeout, and finite `15m`
request-level keep-alive. The lifespan owns and closes one reusable synchronous
HTTP client without contacting Ollama during startup or warming a model.

Prompt contract `animal-photo-v2` uses one Pydantic response model for Ollama's
JSON-schema `format` and incoming validation, with `think: false` and temperature
zero. Existing confidence, review, category, unknown-species, and domestic-animal
normalization remains authoritative after shape validation. The normal resized
derivative remains the model input, and HEIC/HEIF still require their JPEG
derivative.

Each primary or distinct fallback stage has at most one automatic retry after a
fixed two-second pause for explicitly transient timeouts, connection failures,
rate limiting, selected server failures, or malformed structured output. Model
404s skip the same-model retry, request/data/business failures are not retried
blindly, a distinct fallback follows exhausted primary transport retries, and
equal model names never claim fallback provenance. Internal HTTP attempts do not
change durable `attempt_count`; manual Retry still increments it and snapshots
current model/prompt provenance.

Successful load, prompt-evaluation, and generation timing plus sanitized failure
context are console diagnostics only. Existing end-to-end `duration_ms` remains
the durable metric, so Classification Reliability v2 adds no schema, backup,
export, restore, Timeline, Map, Album, or Collection change. FaunaVault reports
Ollama runner/model HTTP failures accurately and never edits Ollama, GPU, or model
configuration.

## Current product feature: explicit catalog bulk actions

The active List catalog now supports transient, ID-based selection across visited
pages within one logical query context. Users can add or remove tags, set or
explicitly clear category, and move only those selected photos to recoverable
Trash through one bounded, typed, atomic backend request. Query/home-view
changes clear selection; flat/grouped and pagination changes preserve it.

The feature deliberately excludes implicit all-results selection, Albums/Trash
selection, permanent deletion, classification, and taxonomy reassignment. It
uses the existing React/Tailwind accessibility primitives and adds no UI or state
framework.

## Current product feature: user-defined Photo Collections

Schema 10 adds normalized persisted Collections and many-to-many Photo
membership. The six peer destinations are List, Timeline, Map, Albums,
Collections, and Trash.
Users can create, rename, and delete Collections, add explicitly selected active
Photos, and remove one or many memberships without changing Photo files or
metadata. Recoverable Trash preserves membership, while permanent Photo deletion
cascades only the join rows.

Backup format v1 now explicitly verifies and rehearses database schemas 9, 10,
and 11. Schema-9 archives migrate to empty Collection tables; schema-10
rehearsals compare Collection metadata and membership exactly; schema-11 also
compares durable capture metadata. Portable metadata export v3 includes those
capture fields after original identity fields while retaining deterministic
Collection records and Trash memberships.

## Current product feature: Photo capture metadata / EXIF

Schema 11 extracts supported EXIF data during the existing loaded-image upload
pass: camera-local capture time and paired offset, camera/lens strings, oriented
dimensions, and complete validated GPS coordinates. Originals remain byte
identical. Capture data is read-only, survives Trash/restore, appears in every
Photo response, supports null-last capture sorting and inclusive local-date
catalog filters, and can be safely filled for existing active/Trash rows with
the dry-run-by-default stopped-archive maintenance command. Geocoding, arbitrary
EXIF blobs, inference, GPS editing, and cloud integrations remain deferred.

## Current product feature: Photo location maps

Active Photos with complete stored GPS now support two focused browsing paths:
a compact one-marker Photo detail map and a dedicated `/map` archive destination.
The archive uses one lightweight projected `GET /catalog/map` query, Leaflet,
and established marker clustering with maximum-zoom spiderfying, including for
multiple Photos at identical coordinates. `?photo=<id>` focuses a point and the
popup returns to the real Photo detail route; no List filtering or bulk-selection
model is duplicated.

No schema migration or geospatial backend was added. Trash membership is derived
from `deleted_at`, so Trash removes a point and restore returns it without changing
GPS. Photo records and thumbnails stay on the local FaunaVault API. Standard
OpenStreetMap raster tiles are requested remotely only for the visible viewport,
with attribution, and are intercepted in browser smoke coverage so CI has no live
tile dependency. Reverse geocoding, search, GPS editing, viewport APIs, spatial
indexes, alternate layers, and offline tile downloads remain explicitly deferred.

## Current product feature: Photo Timeline

The dedicated `/timeline` destination is a compact chronological index into the
existing List catalog. A typed `GET /catalog/timeline` projection groups active
Photos by their stored camera-local `captured_at` year and month, returns fixed
four-photo deterministic thumbnail previews, and reports missing capture dates
without substituting `created_at`. Month links set the existing inclusive List
date filters and newest-captured ordering; List continues to own complete photo
rendering, search, pagination, selection, bulk actions, and detail navigation.

Timeline adds no schema, cache table, dependency, backup/export format, or
maintenance behavior. Capture offsets remain separate metadata and do not shift
month placement. Trash removes Photos from counts/previews naturally, restoration
returns them unchanged, and all supported source formats—including HEIC/HEIF—use
the same capture and thumbnail paths.

## Current product feature: native HEIC/HEIF ingestion

FaunaVault accepts ordinary still `.heic` and `.heif` uploads with exact source
MIME validation. The original container remains authoritative and byte-identical;
the primary image is decoded locally into JPEG resized and thumbnail derivatives
for browser display and Ollama classification. JPEG, PNG, and WebP behavior is
unchanged. A shared immutable format policy now drives upload validation,
serving MIME types, doctor, repair, metadata and perceptual-hash backfills, and
classification fallback rules, so mixed `.heic`/`.jpeg` records are healthy by
design rather than legacy exceptions.

The HEIF opener disables embedded thumbnail, depth, and auxiliary decoding and
uses the container-designated primary image. Existing EXIF extraction supplies
capture, camera/lens, orientation-normalized dimensions, and GPS when present;
no source is guaranteed to carry those fields. Display derivatives use the
codec's 8-bit RGB/RGBA decode without a new color-management promise, while HDR,
wide-gamut, gain-map, higher-bit-depth, and other source information remains in
the original. HEIC editing/re-encoding, HEIC derivatives, browser decoding,
AVIF, HIF/sequence formats, auxiliary/depth browsing, HDR/gain-map processing,
and conversion UI remain deferred.

## Recommended next (in order)

### R1 - Isolated restore rehearsal and backup compatibility — Complete

**Status:** Completed on 2026-08-20. `faunavault-backup rehearse` now verifies a
backup, restores it only into newly created isolated storage, exercises the real
storage startup/migration path, validates preserved metadata and albums, and
requires a healthy archive-doctor result. A committed v1/schema-9 fixture and
explicit supported-backup-schema policy protect historical compatibility.

**Problem:** Backup creation and verification are thoroughly tested, and manual
restore is documented, but no automated check restores a backup into isolated
storage and starts the current application against it. The verifier also accepts
only the current database schema, so compatibility of today's valid v1 backup
after a future schema migration is not yet protected by a fixture or policy.

**Why it matters:** A backup is operationally useful only if it can be recovered.
The highest remaining data-safety risk is an undiscovered gap between verification,
restore layout, startup recovery, migrations, and current runtime expectations.

**Proposed direction:** Add a non-destructive rehearsal path that uses a verified
backup, newly created empty database/image locations, and isolated configuration.
Exercise startup migrations and archive health there, and retain a v1/schema-9
compatibility fixture before adding the next schema migration. Document which
older backup schemas each application version can verify and rehearse.

**Non-goals:** No in-place or one-click production restore, no overwrite of live
storage, no automatic choice of backup, and no deletion of a pre-restore archive.

**Complete when:**

- a valid v1 backup can be copied only into empty isolated locations and passes
  current startup/migrations plus a final archive doctor check;
- active and Trash counts, albums, metadata, and representative original and
  derived images are checked after rehearsal;
- corrupt backups and non-empty targets fail before any restore writes occur;
- the test proves that configured live storage is never opened or modified; and
- the disaster-recovery runbook and backup/schema compatibility policy match the
  exercised workflow.

### R2 - Portable metadata and archive inventory export — Complete

**Status:** Completed on 2026-08-20. `faunavault-export` now produces a
deterministic, independently versioned JSON description of all active/Trash
Photos, Animals, local Taxa, and verified original paths/sizes/SHA-256 values,
with an optional flattened Photo CSV. Snapshot-based online operation, atomic
publication, focused source validation, explicit encoding/null/timestamp rules,
and tests for portability, consistency, safety, Unicode, and empty archives keep
the artifact useful without confusing it with a verified backup or restore path.

**Problem:** Full backups preserve all user data, but their descriptive metadata
is primarily a SQLite database. The manifest exposes file integrity and aggregate
counts, not a stable, human-readable representation of photos, animals, taxonomy,
and Trash state.

**Why it matters:** User-owned metadata should remain inspectable and reusable
without a running FaunaVault application. An export also provides a useful audit
inventory alongside, but not instead of, a verified backup.

**Proposed direction:** Produce a deterministic, schema-versioned JSON export from
a consistent read-only snapshot, with an optional flat photo CSV for common tools.
Include active/Trash state, user-edited photo metadata, stable animal identifiers
and display names, taxonomy provider identifiers/names, timestamps, backup-relative
original paths, sizes, and SHA-256 values.

**Non-goals:** No import path in this item, no cloud sync, no alternate primary
database, no media duplication, and no claim that the export alone can restore
the application.

**Complete when:**

- exports contain no absolute source paths, credentials, or transient staging
  state and have documented encoding, ordering, null, and version semantics;
- active and Trash records, Unicode metadata, linked and unlinked taxonomy, and
  empty archives have focused tests;
- record counts and original-file inventory reconcile with the source snapshot;
  and
- the README explains how to inspect the export with ordinary JSON/CSV tools and
  why verified backups remain the recovery mechanism.

### R3 - Minimal cross-layer browser smoke coverage — Complete

**Status:** Completed on 2026-08-20. A Chromium-only Playwright smoke journey
now runs the production Next.js build and normal FastAPI application against a
new disposable SQLite database and image root. It covers successful upload,
exact-duplicate refusal, possible-duplicate cancellation, catalog/detail routing,
real backend image loading, metadata persistence, Trash restore, confirmed
permanent deletion, and physical variant cleanup. Dedicated ports are never
reused, Ollama and GBIF are not contacted, and a dependent CI job retains
debugging artifacts only on failure.

**Problem:** Backend API tests and Vitest/JSDOM interaction tests are strong but
separate. CI does not currently prove that a real browser, built frontend, and
isolated backend agree on the highest-risk workflows.

**Why it matters:** A small contract-level check can catch routing, serialization,
upload, and lifecycle integration failures that either test layer can miss alone.

**Proposed direction:** Add only a few deterministic local browser workflows for
upload/duplicate review, catalog-detail navigation, and Trash restore/permanent
delete using temporary storage and synthetic images.

**Non-goals:** No broad browser matrix, screenshot suite, real Ollama/GBIF calls,
or attempt to duplicate all component and backend tests.

**Complete when:** The selected flows run against isolated disposable data, cover
both successful and safety-critical refusal paths, add acceptable CI time, and
leave no dependency on the user's archive or network services.

### R4 - Catalog Scale Benchmark and Query Profiling — Complete

**Status:** Completed on 2026-09-29. `python scripts/dev.py benchmark-catalog`
uses owned disposable SQLite/storage state, deterministic metadata, current
schema/index initialization, and the real catalog/Smart Collection/Timeline/Map/
taxonomy services. All 56 scenarios passed correctness checks at 1k, 10k, 50k,
and 100k, with 20 measured iterations per service and captured production plans.
The [benchmark guide](CATALOG_BENCHMARK.md) records methodology, actual median/p95
tables, component costs, seven independent assessments, and validation results.

Default browsing and OFFSET pagination remain adequate under the selected 500 ms
median guideline: 100k first-page/deep-page service medians were 20.22/24.40 ms,
including counts/facets. The slowest production sort was 67.01 ms. Category/date
filters remain inexpensive; Taxon filters approach the guideline at 469.73 ms,
with most time in joined counts.

Current substring search was adequate for the measured 10k personal archive
workload (all medians below 125 ms). Sparse/absent searches exceeded the guideline
at 50k (680.25/671.28 ms), and 100k absent search reached 1403.89 ms. Its count
component alone was 922.53 ms. Common text Smart Collection results/counts reached
586.84/562.91 ms at 100k, with comparable equivalent catalog work. Smart
Collections do not exhibit a separate architecture penalty; their displayed live
count arrives with the full page response. Global facets and default counts remain
small. The taxonomy selector also deserves count-path investigation at 930.97 ms.

No production optimization, new index, schema migration, caching, cursor rewrite,
or FTS experiment was included. This replaces an unmeasured search-scale assumption
with bounded synthetic evidence, not a guarantee for every archive or machine.

### R5 - Catalog count access and substring-search scaling — Complete

**Status:** Completed on 2026-09-30. Full before/after benchmarks passed all 56
scenarios at 1k/10k/50k/100k with 20 measured iterations, identical datasets,
schema/indexes, and methodology. At 100k, common/rare Taxon pages improved from
462.99/471.35 ms to 28.00/22.69 ms, taxonomy selection from 898.12 to 106.62 ms,
common search from 588.31 to 153.95 ms, and no-result search from 1382.43 to
298.38 ms. Shared Smart text page/count medians improved from 568.72/569.02 ms
to 156.01/133.85 ms. `python scripts/dev.py check` passed with 401 backend tests,
six platform skips, all 111 frontend tests, lint/typecheck, and production build.

R5 changes broad count access using existing SQLite indexes. Unrestricted text
counts select active Photo IDs and reuse per-term Animal/Taxon matches; broad
Taxon counts obtain Photo IDs through relationship indexes. Selective Photo
filters and item-query sorting/pagination retain their existing formulations.
An exact zero count now skips the items query while retaining global facets.
The taxonomy selector groups active Photos by Taxon ID before joining labels.
Smart Collections benefit through the same catalog service.

There is no schema migration, new index, FTS, cache, frontend, or pagination
change. Escaped literal substring, current case behavior, conjunctive terms,
all searchable fields, active/Trash behavior, counts, and selected-Taxon semantics
are covered by focused tests and the independent benchmark oracle. The
[benchmark guide](CATALOG_BENCHMARK.md) retains R4 and records R5 root causes,
rejected experiments, separate count/zero-result ablations, full paired timings,
plans, regressions, and validation.

Default/filtered browsing, sorting, and deep pagination retain healthy access.
All measured catalog counts and Smart result/live-count scenarios are now below
the 500 ms median reporting guideline. Text search still requires conditional
follow-up for sparse positive results: rare search is 533.98 ms and the slowest
100k text scenario is literal backslash search at 757.74 ms. Item retrieval still
scans active candidates, and substring evaluation remains linear. Investigate
those residual costs in a separate branch only if lower latency is required;
these measurements do not mandate a production FTS migration.

## Conditional work

| Candidate | Current conclusion | Trigger to reconsider |
| --- | --- | --- |
| SQLite FTS | Production migration remains deferred. R5 materially improved count/join access with existing indexes and SQL membership, without an FTS experiment. Sparse positive searches still have linear matching and item-traversal costs; the slowest measured 100k text scenario remains 757.74 ms. See the preserved R4 and new R5 [measurement report](CATALOG_BENCHMARK.md). | If lower sparse-search latency is required, isolate remaining substring and item costs in a separate branch. Compare benchmark-only FTS only when matching warrants it and literal characters, short substrings, current case behavior, conjunctive terms, relationship fields, and active/Trash semantics can be retained. |
| Derivative force regeneration or format/quality migration | Not needed while current dimensions, formats, and quality settings remain valid. Doctor and repair already handle missing or invalid derivatives and deliberately preserve healthy files. | The variant algorithm, size, quality, or output format changes and existing healthy derivatives must be upgraded deliberately. |
| Backup format v2 | Not needed for the current complete, portable, uncompressed cold backup. Schema compatibility should be solved without changing the container format unless necessary. | A requirement such as compression, encryption, incremental storage, or incompatible payload layout cannot be added safely within v1 compatibility. |
| Persistent local diagnostic logs | Not scheduled. Durable job records, focused domain warnings/errors, Uvicorn output, and explicit backup/maintenance reports cover current operations without enterprise observability. | Repeated upload, lifecycle, classification, backup, or maintenance failures cannot be diagnosed from current state and console output, or a packaged runtime no longer has a useful console. Use bounded local logs and operation IDs only; no telemetry or external collector. |
| Additional state/build/orchestration tooling | Not justified by the current frontend boundaries or root commands. | Shared client state, test runtime, release complexity, or multi-process development becomes a measured source of defects or material delay. |

## Intentionally deferred

- Cloud sync, multi-device coordination, authentication, and multi-user roles.
- External databases, distributed queues, Redis/Celery, message brokers,
  microservices, containers, or orchestration platforms.
- Telemetry, SaaS monitoring, external log collectors, vector search, or
  perceptual-similarity search.
- Destructive automatic restore, automatic original recovery, orphan deletion,
  automatic Trash expiry, or metadata/row reconstruction from guesses.
- Scheduled remote/incremental backup management and background maintenance
  workers until a concrete retention or unattended-operation requirement exists.

These are product-boundary decisions, not unfinished work. Reconsider them only
when FaunaVault's actual requirements change.
