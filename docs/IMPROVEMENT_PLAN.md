# FaunaVault Engineering Improvement Roadmap

Reviewed against `master` on 2026-08-20.

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
  photo, animal, and local taxonomy fields. Pagination and non-text filters are
  indexed; leading-wildcard text search intentionally scans active candidates.
- Frontend state is route-local or held in focused hooks. Durable work is restored
  from the backend; transient browser-only upload and dialog state is not treated
  as persistent application state.

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

## Later

### R3 - Minimal cross-layer browser smoke coverage

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

## Conditional work

| Candidate | Current conclusion | Trigger to reconsider |
| --- | --- | --- |
| SQLite FTS | Not justified now. Current substring search is scan-based, but the indexed, paginated catalog remains appropriate for a personal archive in the low tens of thousands without observed latency evidence. FTS would add synchronization and query-semantics complexity. | Representative searches on a real-sized archive become noticeably slow and profiling identifies text matching, rather than facets, joins, sorting, or image loading, as the cause. Benchmark the existing query and an FTS prototype before choosing it. |
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
