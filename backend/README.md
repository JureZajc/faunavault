# FaunaVault backend

The FastAPI backend owns local SQLite metadata, image lifecycle operations, migrations, taxonomy behavior, and durable Ollama classification jobs. Run it from this directory with:

```powershell
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

As an optional repository-root shortcut, run `python scripts/dev.py backend`.

Validation:

```powershell
uv run ruff check .
uv run ruff format --check .
uv run pytest
```

Configuration is loaded through `pydantic-settings` from `backend/.env`. Relative SQLite paths resolve against this directory. See the root README for storage, backup, migration, and recovery details.

## Perceptual duplicate detection

Uploads retain the authoritative SHA-256 duplicate check. After it finds no
exact match, the lifecycle service calculates the Pillow-only `phash64-v1`
fingerprint and scans persisted active and Trash hashes. Matches at Hamming
distance four or less return `possible_visual_duplicate`; they never mutate an
existing photo. `allow_visual_duplicate=true` still recalculates the hash and
scans current candidates, but authorizes the new record after that analysis.

Migration 9 adds the nullable 16-character hash. Lifespan startup runs a
resumable backfill outside the migration transaction: one decode at a time,
25 rows per batch, short database updates, and a 100 ms yield between batches.
Missing/unreadable originals remain null and exact duplicate handling remains
fully available. `GET /photos/{id}/thumbnail` provides safe active-or-Trash
candidate previews without returning storage filenames in duplicate responses.

Backup format version 1 is unchanged. Verification checks only the persisted
hash format and never decodes images or recomputes perceptual hashes; SHA-256
continues to protect original-file integrity.

## Verified local backups

Keep the backend stopped for the entire backup creation command, and provide an
existing local destination directory:

```powershell
uv run faunavault-backup create E:\FaunaVaultBackups
uv run faunavault-backup verify E:\FaunaVaultBackups\faunavault-backup-<timestamp>-<id>
uv run faunavault-backup rehearse E:\FaunaVaultBackups\faunavault-backup-<timestamp>-<id> E:\FaunaVaultRehearsals\recent-backup
```

`create` resolves the configured SQLite and image locations, rejects active
upload/purge staging, validates the archive, creates a SQLite backup snapshot,
copies all active and Trash image variants, writes SHA-256 metadata, verifies
the temporary backup, rechecks lifecycle state, and atomically publishes it.
Absolute source paths are not written by default. The destination may not
overlap the database directory or active image storage.

`verify` is read-only and backup-local: it does not load `.env`, access the live
archive, run migrations, or modify the backup. It validates format and schema
versions, safe relative paths, checksums, SQLite integrity/foreign keys,
migration metadata, counts, and every database-to-image reference. `create` and
`verify` exit `0` for success (including warnings) and `1` for invalid or failed work.
Unexpected regular files are warnings; missing/changed owned files and symlinks
or junctions are failures.

`rehearse` is an isolated recovery proof, not an automated production restore.
It never loads normal live settings. The target must not exist; the command
verifies the source before target writes, copies into same-parent staging,
exercises the storage-only startup/migration path, performs metadata and album
checks, recovers interrupted running jobs without starting the worker, and runs
the existing archive doctor before atomically publishing the retained target.
Warnings are allowed only when doctor still reports `HEALTHY`; errors and
repairable derivative defects fail the rehearsal. Exit `1` means integrity or
recoverability failure and exit `2` means usage, target, permission, disk, or
other setup failure.

Backup format v1 and database recovery versions are independent. This version
explicitly supports schema 9 backups. A later application schema must retain the
frozen schema-9 verifier and migration rehearsal unless compatibility is
intentionally removed and documented. The root README contains the compatibility
table, target layout, limitations, and unchanged manual production-restore
procedure.

## Live archive maintenance

Stop the backend before operating on the configured live archive:

```powershell
uv run faunavault-maintenance doctor
uv run faunavault-maintenance repair-derived
uv run faunavault-maintenance repair-derived --apply
```

`doctor` is read-only and covers SQLite/schema integrity, active and Trash
inventory, authoritative original hashes/sizes/decodability, structurally valid
resized and thumbnail files, safe paths, lifecycle state, perceptual-hash format,
and bounded orphan reporting. `repair-derived` defaults to a dry run; only
`--apply` atomically replaces missing or invalid derivatives whose originals are
fully trusted. It never changes originals, database rows, metadata, hashes,
taxonomy, jobs, or Trash state, and it never deletes orphans. Non-empty
`.staging` or `.purge` blocks both operations. Apply uses same-directory unique
temporary files and the exact upload variant generator, then performs a complete
doctor pass.

Exit `0` means healthy with optional warnings, `1` means integrity errors or
repairable defects remain, and `2` means usage/configuration/startup failure.
Missing or damaged originals require recovery from a verified backup; the
maintenance CLI cannot recreate them. See the root README for the complete cold
operation, interruption, and Windows atomic-replacement guidance.

Classification is asynchronous and local-first. One lifespan-owned in-process worker claims SQLite jobs in `queued_at` order and processes them serially. Status and safe failures survive browser refresh and backend restart; interrupted running jobs are marked failed for explicit retry. The worker records requested/actual model, fallback use, attempt count, duration, and prompt version. FaunaVault supports one backend process, not multiple Uvicorn workers.

`POST /classification-jobs`, `GET /classification-jobs`, `GET /classification-jobs/{id}`, and `POST /classification-jobs/{id}/retry` are the canonical API. The retained `/photos/{id}/classify` and `/photos/classify-pending` URLs now return HTTP 202 job resources and no longer provide synchronous response contracts.

The scalable catalog API is `GET /catalog/photos`. It performs pagination,
search, status/category/verified-taxon filtering, deterministic sorting, total
counting, and small status/category facets in SQLite. Page size defaults to 48
and is capped at 100. `GET /catalog/taxa` provides bounded pages of stable local
taxon IDs with labels and active-photo counts for the List selector. The legacy
`GET /photos` response and semantics remain unchanged.

Schema migration 7 supplies the three catalog indexes justified by generated
archive query plans: active created-time order, active status plus created-time
order, and active category plus created-time order. Existing relationship
indexes serve verified-taxon filtering. Leading-wildcard substring search still
examines active candidates; no speculative indexes are created for search text.

Species album list, taxonomy-filter, detail, assignment, and reconciliation
discovery paths are SQL-backed and no longer build the complete archive in
Python. Album identity remains `taxon:{local_id}` for verified taxa and the
existing normalized, unpadded URL-safe Base64 key for legacy names. SQLite album
search uses a deterministic connection-local Python `lower()` function plus
literal `instr()` matching so Unicode case behavior remains compatible with the
former Python filtering.

Schema migration 8 persists the exact Python-normalized legacy species group on
each animal and indexes it for direct lookup. The original legacy name remains
unchanged for display and URL compatibility. Generated isolated query plans use
the existing photo relationship/active indexes and animal taxon index; a tested
additional photo composite index did not improve those plans, so no speculative
photo index was added.

Taxonomy is local-first and separated from remote GBIF access. Every taxonomy
search reads current local `Taxon` rows from SQLite, then merges parsed remote
GBIF search records. Successful remote search records alone are cached in a
bounded in-process cache for ten minutes; cache hits are re-deduplicated against
fresh local state. If GBIF fails, matching local results remain available with a
warning, while a search with no local result retains the safe HTTP 503 response.

`app.clients.gbif.GbifClient` owns GBIF requests, response validation, accepted
taxon resolution, a 3-second connection timeout, and a 10-second request/read
timeout. It performs no automatic retries. The application lifespan owns one
underlying synchronous `httpx.Client` and explicitly closes it during shutdown,
including exceptional cleanup paths. Taxonomy services receive the client
explicitly, so backend tests use deterministic fakes or `httpx.MockTransport`
and never require internet access. Remote resolution finishes before short
SQLite write transactions; accepted GBIF taxa are reused through the existing
unique provider/external-ID constraint.
