# FaunaVault operations

Detailed workflows and API behavior for the source-based application. Start with
[Quick Start](../README.md#quick-start). Backend commands below run from `backend`;
root developer commands run from the repository root.

## Configuration and initialization

Backend settings load process environment values before `backend/.env`, then
use application defaults. The repository-root `.env` is not loaded. Frontend
settings use `frontend/.env.local`; its example sets `NEXT_PUBLIC_API_URL` to
`http://localhost:8000`. Environment files are optional for default local use.
Never overwrite existing environment files during upgrades.

Defaults on every platform are `backend/data/faunavault.db` and
`backend/data/images`. `DATABASE_URL` selects SQLite; `IMAGE_DIR` selects images.
`DATA_DIR` does not relocate either independently. Relative SQLite paths resolve
against `backend`; relative data/image paths retain their working-directory
semantics, so use absolute paths for custom storage. Root commands launch the
backend from `backend` regardless of the invoking directory.

To customize, copy `backend/.env.example` to `backend/.env` and edit its commented
storage overrides. Windows SQLite URLs look like
`sqlite:///E:/FaunaVault/data/faunavault.db`; Unix absolute URLs look like
`sqlite:////home/alice/FaunaVault/data/faunavault.db`. Keep the database and entire
image root when moving storage, and stop the backend first.

Starting `python scripts/dev.py backend` runs the authoritative initializer:
necessary database-parent, original, resized, thumbnail, `.staging`, and `.purge`
directories; SQLite tables; ordered migrations; and interrupted-purge recovery.
Migrations are currently 1 through 13 and retain their historical ordering.
Pre-migration database snapshots supplement full backups. Restart does not reset
the archive or repeat successful migrations. Interrupted classification jobs
become failed for explicit retry; queued jobs retain normal processing behavior.

For upgrades from old implicit E-drive defaults, set `IMAGE_DIR` to the existing
image root explicitly. A populated database paired with absent/empty implicit
portable originals is refused before initialization writes. Nothing is moved or
automatically selected. Archive initialization is normal backend startup; there
is no reset command in setup.

## Setup diagnostics

```powershell
python scripts/dev.py doctor
python scripts/dev.py doctor --ollama
# Stop the backend before the full archive scan:
python scripts/dev.py doctor --archive
```

The default checks Python 3.12+, uv/npm, Node 24+, required backend imports,
frontend command installation, configuration, storage access, and migration
readiness. It creates no directories/database and does not apply migrations.
Missing first-run storage is `OPTIONAL`; pending migrations are `WARNING`;
invalid settings or inaccessible existing storage are `FAIL`. Directory access
checks are advisory: only initialization can prove actual write permission.
`PASS`, `WARNING`, `FAIL`, and `OPTIONAL` are printed separately. Root exit codes
are 0 for core readiness (warnings allowed), 1 for failed checks, 2 for checks
that could not run reliably, and 130 for interruption.

`--archive` composes the existing cold archive doctor, which validates files and
integrity and requires initialized current-schema storage. Its existing exit
codes and detailed findings remain authoritative. `--ollama` makes one bounded
`/api/tags` request and checks configured primary/fallback models. Unavailable
Ollama or missing models never fail core setup; no model is downloaded.

The backend-only setup equivalent is
`uv run --no-sync faunavault-maintenance doctor --environment-only`, with
`--ollama` if requested. Plain `faunavault-maintenance doctor` retains its full
archive scan behavior.

## Interactive uploads

The catalog uploads a multi-file selection one file at a time and shows each
file's real state: `Waiting`, `Uploading`, `Uploaded`, `Exact duplicate`,
`Possible duplicate`, or `Failed` (`Cancelled` is shown after the user cancels
a possible-duplicate review). The display reports the active file's ordinal,
such as `Uploading 2 of 5`; it does not invent byte-level percentages because
the current request layer does not receive byte progress.

One file's validation, duplicate, network, or server outcome does not roll back
completed siblings or stop later queued files. A failed item can be retried in
place when the failure is transient (a network error or HTTP 5xx response),
without re-uploading completed files. Possible visual duplicates remain pending
for independent review after the initial queue has finished, so each can be
kept or cancelled without changing the other file outcomes.

Catalog refreshes are batched around those phases instead of running after every
successful file: once after the initial pass when it saved photos, and once
after the duplicate-review queue drains when `Keep both` saved additional
photos. A refresh failure is reported separately and does not relabel an
already accepted upload as failed. The backend's compatibility batch-upload API
remains available, but the interactive catalog uses the single-photo endpoint
to provide these per-file states and retries.

## Import a local photo folder

Start the backend once to initialize or migrate the archive, then stop it before
an actual import. From `backend`, run:

```powershell
uv run --no-sync faunavault-import "E:\Photos\Wildlife" --recursive --dry-run
uv run --no-sync faunavault-import "E:\Photos\Wildlife" --recursive
uv run --no-sync faunavault-import "E:\Photos\Wildlife" --recursive --classify
```

On macOS or Linux:

```sh
cd backend
uv run --no-sync faunavault-import ~/Pictures/Wildlife --recursive --dry-run
uv run --no-sync faunavault-import ~/Pictures/Wildlife --recursive
```

Without `--recursive`, only files directly inside the source directory are
processed. FaunaVault reads source files without moving, renaming, deleting, or
changing them, and keeps its own byte-for-byte copies in managed storage.
JPEG, PNG, WebP, HEIC, and HEIF use the same validation and size limits as
browser uploads. Unsupported files are skipped. Exact SHA-256 duplicates,
including photos in Trash and files imported earlier in the run, are skipped;
repeating an import does not create another Photo for the same bytes.

Possible visual duplicates are reported separately and skipped by default. Use
`--allow-visual-duplicates` to keep both; exact duplicates still cannot be
imported twice. `--verbose` prints each file's outcome. Without it, progress
appears every 100 files plus duplicate and failure details and a final summary.
Corrupt or unreadable photos are reported and later files continue. A run with
file failures exits with status 1; setup errors exit with status 2.

`--dry-run` may run while the backend is online. It validates and hashes files,
checks exact and possible visual duplicates, and predicts how earlier files in
that scan affect later ones. It creates no photos, archive files, derivatives,
or classification jobs. It requires an initialized, current-schema archive.

New photos remain pending, as with browser uploads. `--classify` queues durable
classification jobs for newly imported photos only, without running the model
in the CLI. Those jobs are processed after the backend restarts. A dry run with
`--classify` reports planned jobs but creates none. The source folder should
stay stable during the scan, and actual imports should run with the backend
stopped.

## Catalog API and navigation

The main List view uses `GET /catalog/photos`, a backend-paginated and
backend-filtered API with 48 items by default and a maximum page size of 100. It
supports `page`, `page_size`, `search`, `status`, `category`, `uncategorized`, `taxon_id`,
`taken_from`, `taken_to`, `sort`, and `order`. Capture-date bounds are inclusive
camera-local dates, and `sort=captured_at` keeps unknown capture dates last.
Responses include the filtered `total`, `total_pages`, and
small global status/category facets. Search is a case-insensitive SQLite
substring search across photo metadata, tags, animal names, and locally stored
taxonomy; whitespace-separated terms must all match somewhere in the record.

Verified taxon choices are loaded separately and in bounded pages from
`GET /catalog/taxa`. Each option uses the stable local `Taxon.id` and includes
its display label, scientific name, and active-photo count. The legacy
`GET /photos` endpoint remains unchanged and still returns the complete active
Photo array for compatible consumers.

The six peer archive destinations are List, Timeline, Map, Albums, Collections,
and Trash. Timeline has its own `/timeline` route and reads a compact,
deterministic `GET /catalog/timeline` projection of active Photos grouped by the
camera-local year and month stored in `captured_at`. Each month shows four
newest-captured thumbnail previews and links to the existing List using its
inclusive `catalog_taken_from` / `catalog_taken_to` URL filters with capture-date
sorting. Photos without capture metadata are reported separately and are never
assigned an import date or fabricated month; JPEG, PNG, WebP, HEIC, and HEIF
participate identically when capture metadata exists.

Map has its own `/map` route and reads a lightweight, deterministic
`GET /catalog/map` projection containing only active geotagged Photos and the
metadata needed for markers and previews. Nearby points cluster, exact-coordinate
points remain distinct through spiderfying, and `/map?photo=<id>` focuses a
specific active point. Map does not duplicate List filters or bulk selection.

List page, search, filters, sorting, verified taxon, and flat/grouped layout are
stored in URL search parameters. Refresh, copied URLs, browser Back/Forward,
and photo detail return navigation restore the same catalog context. Grouping
is intentionally page-local once pagination is active.

The List view also offers an explicit Select mode. Selection contains only photo
IDs the user checks and can span visited pages within the same search/filter/sort
context. Search, filter, sort, Map, Albums, Collections, or Trash changes clear it; flat/grouped and
page changes do not. Select page means the currently loaded page only, requests
are capped at 250 photos, and there is no select-all-results behavior. Bulk actions
can add/remove tags, set or explicitly clear category, add photos to one persisted
Collection, or move active photos to recoverable Trash. Permanent deletion is
never available as a bulk action.

Collections are manually named groups with stable numeric IDs and explicit
many-to-many Photo membership. Create, rename, and delete them under
`/collections`; deleting a Collection never deletes Photos or files. Collection
pages show active Photos in catalog order and support single or selected removal.
Membership survives recoverable Trash and becomes visible again on restore;
permanent Photo deletion removes the corresponding membership rows.

Smart Collections are named saved List queries with live membership. In List,
set search, status, category or Unknown, verified taxon, capture dates, and sort,
then choose **Save as Smart Collection**. An unfiltered “All photos” query is
valid. Page, page size, flat/grouped layout, and selection are never saved.
Find Smart Collections in a separate section under `/collections`; open one at
`/collections/smart/<id>` to see its current count and paginated results. **Edit
criteria** restores the query in List and **Save changes** updates the same
Smart Collection. Metadata edits, new Photos, Trash, and restore immediately
change results because no membership rows are stored. Deleting a Smart
Collection deletes only its saved query. Bulk **Add to Collection** still
targets manual Collections. Saved query version 1 has explicit validated
fields; an unsupported or damaged definition is shown as invalid and can be
replaced from List without affecting other collections.

`POST /photos/bulk` accepts a discriminated operation body with explicit
`photo_ids`. The backend validates the complete active set before mutation and
commits metadata changes or Trash/job-state transitions atomically.

## Exact and possible visual duplicates

### Duplicate Review Center (v0.2 development)

Open **Duplicates** (`/duplicates`) to curate possible visual duplicates already
stored in the archive. The view shows one canonical pair at a time, strongest
fingerprint similarity first, with both previews, normal detail/lightbox access,
and capture/camera/file metadata. A distance of zero means equal perceptual
fingerprints, not identical original bytes. A shared SHA-256 original is an
archive-integrity anomaly, reported by `doctor` and the scan rather than offered
as an ordinary visual candidate.

**Keep both / Not duplicates** records a persistent decision for that pair's
fingerprint evidence and detector version. It leaves both Photos and their
metadata unchanged. **Skip** only advances the view; it wraps to the first pair
and never resolves a candidate. Similarity is pairwise: A/B and B/C candidates
do not establish that A/C are similar.

Moving either side to Trash uses the normal confirmation and recoverable
lifecycle. Every pair involving a trashed Photo leaves the active queue.
Restoring it reopens unresolved pairs; explicit Keep both decisions survive
Trash and restoration. Permanent deletion remains in Trash and cascades removal
of dependent pair records. This page offers no permanent-delete action.

Browser upload Keep both also saves dismissals for the specific displayed
candidates. Folder import still skips visual duplicates by default;
`--allow-visual-duplicates` permits ingestion but leaves detected pairs unresolved
for curation. Neither override bypasses exact-duplicate protection, including
originals in Trash. Ingestion persists the same at-most-three matches it already
looks up; it does not perform a second archive scan.

For existing archive Photos and full pair discovery, stop the backend and folder
importer and keep them stopped for the entire operation. From `backend`:

```powershell
uv run --no-sync faunavault-maintenance duplicates-scan
uv run --no-sync faunavault-maintenance duplicates-scan --apply
```

The default is a read-only dry run; `--apply` saves candidates and scan status in
SQLite. Schema 14 must already be initialized by normal startup. Safe configured
storage and empty staging/purge journals are required. The command compares
stored `phash64-v1` fingerprints at the same Hamming distance threshold of four,
including active and Trash Photos. It never decodes images, modifies original
bytes, calls Ollama, uses the network, or starts a persistent scanner. Missing
fingerprints are explicitly counted as unassessed; normal startup's existing
fingerprint backfill remains responsible for generating them. Malformed archive
state fails preflight instead of being silently repaired.

The existing five-part importer index narrows candidates before exact distance
checks. Work scales with bucket occupancy and qualifying pairs; dense sets may
still require quadratic output. Buffers hold at most 500 pairs and the index is
proportional to Photo count. Defaults stop an attempt at 50 million bucket-entry
visits or one million qualifying visual pairs. To deliberately increase either
budget, use positive `--max-probes` or `--max-pairs` values. Progress and a final
summary report counts, timing, skipped fingerprints, and exact-SHA collision IDs.
Exit code 0 means completed discovery without exact anomalies; 1 means incomplete
discovery or exact anomalies; 2 means setup/usage failed.

Each applied attempt is marked incomplete before writes. Batches commit
atomically, unchanged evidence retains dismissal/discovery timestamps, and
interruption preserves completed work. Rerun from the beginning; identical pairs
are not duplicated. Limits apply to each attempt, so raising a reached budget
is necessary to get beyond the same stopping point. External database commits
stop the scan and require a cold rerun. No candidates are deleted by a scan.

The page displays scan coverage independently from queue completion. A completed
scan covers valid stored fingerprints at that time; new ingestion/backfill may
require another scan. “No possible duplicates need review” describes the current
queue under these rules and does not guarantee absence of similar photos.

Canonical pair records contain evidence snapshots and `phash64-v1:d4`. New
evidence/version cannot inherit an old dismissal silently. Candidates are derived
and reproducible, while explicit dismissals are user-curation data. Schema-14
verified backups include both pair records and scan state, and rehearsal checks
their preservation. Backup v1 and historical schemas 9–16 remain supported.
Portable metadata export v7 intentionally excludes duplicate curation state; use
verified backups to preserve decisions during recovery.

### Ingestion detection

Byte-identical uploads are detected by SHA-256 and rejected with HTTP 409. This
authoritative rule also applies when the existing photo is in Trash and cannot
be bypassed.

After the SHA check, the backend calculates a local `phash64-v1` perceptual
fingerprint from EXIF-oriented, metadata-independent pixels and compares it with
active and Trash photos. A Hamming distance of four or less is treated only as
evidence of a possible visual duplicate. The upload is not finalized until the
user chooses `Keep both`; confirmation re-uploads and fully re-analyzes the file,
including a fresh exact check and candidate scan. Cancel leaves no server-side
staged file. Burst frames, crops, recoloring, and structurally similar photos can
produce warnings, while stronger edits may not be detected.

Schema migration 9 adds the nullable fingerprint field. Existing originals are
hashed by a resumable background task, one image at a time in batches of 25 with
a short pause between batches so API, upload, and classification work can
interleave. Missing or unreadable originals remain nullable and are reported by
photo ID; exact duplicate protection stays active throughout. Candidate previews
use an ID-based photo endpoint and do not expose perceptual hashes or storage
filenames.

## Architecture and storage

- Frontend: Next.js 16, React 19, TypeScript, Tailwind CSS
- Backend: FastAPI, Python 3.12+, SQLModel, SQLite, Pillow
- AI: local Ollama (`qwen3-vl:8b` for primary and fallback by default)

The portable defaults store images under `backend/data/images` and SQLite metadata under `backend/data/faunavault.db`. Existing `.env` values take precedence; upgrades do not relocate data. Originals are preserved byte-for-byte. Resized and thumbnail files are reproducible derivatives. JPEG, PNG, and WebP retain their existing derivative formats; HEIC and HEIF originals use JPEG previews so every existing catalog, detail, Map, lightbox, and classifier path remains browser-compatible.

HEIC/HEIF decoding and preview conversion happen locally through the locked
Pillow codec dependency; no photo is sent to a conversion service and no system
codec installation is required. For a multi-image container, FaunaVault uses
the HEIF-designated primary image and ignores embedded thumbnails, auxiliary or
depth images, and other frames while retaining the complete source container.
Preview decoding is 8-bit RGB/RGBA and does not promise HDR, gain-map, or ICC
color fidelity; that source information remains only in the untouched original.
HEIC/HEIF editing, re-encoding, AVIF, sequence formats, and client-side HEIC
rendering are not supported.

On upload, schema 11 stores supported image-stated metadata without rewriting
the original: EXIF capture time and its separately recorded offset, camera make
and model, lens model, oriented dimensions, and a complete valid GPS pair. A
missing or malformed optional tag remains null and does not reject a valid
image. `created_at` continues to mean when FaunaVault added the record; capture
time never falls back to it. GPS stays in the local SQLite database and appears
as plain coordinates plus an interactive map. Photos without complete GPS do not
show a detail map or appear on the archive Map. Moving a Photo to Trash removes
it from Map; restore returns it without changing its coordinates.

EXIF/GPS extraction is local and uses the metadata exposed by the decoded
primary image. Not every camera or exported HEIC/HEIF file contains these tags,
so capture, camera, lens, and location fields may legitimately remain blank.

The basemap defaults to standard OpenStreetMap raster tiles with visible
attribution. The browser requests only tiles for the visible viewport; FaunaVault
does not send photo records, filenames, species, tags, or thumbnails to the tile
provider. Remote tiles mean basemap rendering is not offline, and there is no
reverse geocoding, place search, coordinate editing, tile downloader, analytics,
or external map metadata API.

Normal deletion only sets a deleted timestamp. Trash continues to reference the same local files. A photo must be moved to Trash before it can be permanently deleted. Permanent deletion stages variants in a private journal, commits the row deletion, and cleans the staged files; interrupted work is reconciled on the next backend startup.

## Local AI classification jobs

Classification requests are persisted in SQLite and processed serially by a lightweight worker inside the single FastAPI process. The browser does not need to stay open: queued and running state survives navigation and refresh, while completed and failed jobs remain visible with their model, duration, attempt count, and prompt version.

Jobs use `queued`, `running`, `succeeded`, and `failed` execution states. A succeeded result may still set the photo to `needs_review` when confidence is low or the model requests review; that is not an execution failure. Failed jobs require an explicit retry. Retry reuses the job, increments its durable attempt count, refreshes `queued_at`, and snapshots the current model and prompt configuration. A short internal Ollama retry does not increment this user-visible count.

Classification uses Ollama JSON-schema structured output with prompt contract `animal-photo-v2`, `think: false`, temperature zero, and a request-level keep-alive. For Qwen3-VL/Ollama combinations that return schema-valid metadata in `thinking` while leaving `response` empty, FaunaVault accepts that alternate channel only after the same strict validation and does not log its contents. The primary model receives one automatic retry after a two-second pause only for timeouts, connection interruptions, rate limiting, selected server failures, or malformed structured output. A distinct fallback runs after the primary retry is exhausted, immediately when the primary model is missing, or when a valid primary result has low confidence. The fallback has the same bounded retry policy. Identical primary and fallback models never create a fake fallback stage.

Connections time out after 5 seconds and classification response reads after 180 seconds by default. With identical models, one pathological Photo can hold the worker for about 6 minutes; a distinct primary and fallback can take about 12 minutes in the worst case. Exhaustion marks only that job failed and the serial worker continues with the next queued Photo. Malformed output and Ollama failures remain safe failed jobs without overwriting Photo metadata.

FaunaVault's HTTP read timeout is separate from an Ollama HTTP 500 reporting that its model or runner failed to load in time. FaunaVault logs Ollama's sanitized server detail and successful load/prompt/evaluation timing breakdown, but it does not modify Ollama, GPU, runner, or model-storage configuration. Detailed diagnostics remain console logs; only end-to-end job `duration_ms` is persisted.

An unexpected backend stop marks any interrupted running job failed on restart with an explicit retry action; work is never silently repeated. Moving a photo to Trash fails queued/running work, and a delayed Ollama response cannot write metadata after Trash or a manual edit. Restoring the photo permits explicit retry but does not restart work automatically.

FaunaVault supports one local backend process and one classification worker. Do not run multiple Uvicorn workers; distributed worker coordination is deliberately out of scope.

The existing `POST /photos/{id}/classify` and `POST /photos/classify-pending` URLs are retained, but both now return asynchronous HTTP 202 job resources instead of synchronous Photo or batch-result bodies. There is no legacy synchronous Ollama classification route. The canonical resource API is `POST/GET /classification-jobs` plus `POST /classification-jobs/{id}/retry`.

## Editable capture metadata (v0.2)

Open an individual Photo and choose **Edit metadata** to add or correct its
capture date/time, optional signed UTC offset, and latitude/longitude. Capture
time is the camera-local wall time; neither browser timezone nor GPS changes it.
An empty offset is valid. Latitude must be −90 to 90, longitude −180 to 180, and
both finite coordinates must be supplied together. Camera/lens/dimensions remain
read-only. There is no bulk capture editor, geocoding, or timezone lookup.

The Taken and Location rows show **Manually edited** or **Manually cleared** when
applicable. **Clear capture date** also removes the offset; **Remove location**
removes both coordinates. These intentional clears remain protected from EXIF
backfill. They move Photos into Timeline's missing-date behavior or remove their
Map point. Changes immediately determine catalog date sorting/filtering and
live Smart Collection membership through the shared catalog queries.

**Restore original metadata** is staged in the same form. Save re-reads only
capture time/offset and GPS from the trusted original, updates retained source
values, and removes both manual overrides. Missing supported EXIF becomes empty
metadata. A missing, corrupt, changed, or untrusted original prevents the entire
save; the form retains its draft. Cancel discards staged edits and Restore.
Stale saves are refused and require refreshing before saving again.

Schema 15 keeps effective metadata, four retained extracted values, and separate
capture/location override markers. Migration copies the previously persisted
capture/GPS baseline; it does not scan image files. Capture-only correction and
Restore do not accept pending AI classification review. Original files and EXIF
bytes are never rewritten, nor are derivatives regenerated. Trash restoration
preserves both corrections and provenance. Backup-v1 schemas 9–16 are supported;
verification/rehearsal preserve all new fields. Portable JSON/CSV export v7
includes effective values, retained extraction, and both markers.

`backfill-photo-metadata` remains a stopped-archive, dry-run-by-default command.
It fills missing retained extraction and eligible missing effective groups;
manually overridden groups, including null clears, are never repopulated.
Conditional writes prevent stale extraction from overwriting a newer edit.
Applied metadata changes advance the Photo version while preserving AI review
state. Active and Trash Photos receive the same protection.

## AI Review Inbox

Open **Review** at `/review` to process active photos whose AI result has `status = needs_review`. The inbox shows one photo at a time in oldest-first order, with its metadata, confidence, linked animal/taxonomy, available classification provenance, and job state. The URL may include `?photo=<id>`; Previous/Next and Left/Right arrows navigate, while Skip moves on without changing metadata. Trash photos are never listed. A missing or already reviewed link opens the first remaining item.

**Accept** confirms the current result, changes the photo to `classified`, and records `reviewed_at` without removing its classification jobs. **Edit** uses the existing photo metadata editor; an actual manual metadata change anywhere in the app, including bulk tag/category edits, resolves `needs_review` and records `reviewed_at`. A no-op save leaves the item in review. Taxonomy selection alone does not confirm the photo; use Accept afterward. **Reclassify** uses the durable job API, and failed jobs retain the existing Retry action. If Ollama is unavailable, the photo stays in review with the failed job visible. Active jobs block Accept; edits still invalidate delayed results through `updated_at`.

Schema migration 12 adds nullable `photo.reviewed_at`. A new AI result clears it. Existing classified photos retain `null` because their past review history cannot be determined. `GET /review?photo=<id>` returns the count, current photo, ordinal position, neighboring IDs, and a low-confidence flag using the configured threshold. `POST /review/photos/{id}/accept` takes `expected_updated_at` and returns the remaining count and next ID; stale, trashed, changed, or active-job photos return HTTP 409. `PATCH /photos/{id}` accepts optional `expected_updated_at` for guarded edits. The original model review flag and exact reason are not stored, so the UI gives a specific low-confidence reason only when supported by the saved score.

## Portable metadata export

FaunaVault can export a deterministic, schema-versioned inventory of all Photo,
Animal, locally stored Taxon, Collection, and Collection-membership metadata
without copying media. JSON is the
authoritative representation; an optional flat Photo CSV is available for
spreadsheets and ordinary data-analysis tools. Both active and Trash Photos are
included, with portable original paths, actual streamed sizes, and SHA-256
values.

From `backend`, choose a new destination directory whose parent already exists:

```powershell
uv run --no-sync faunavault-export E:\FaunaVaultExports\metadata-2026-08-20
uv run --no-sync faunavault-export E:\FaunaVaultExports\metadata-2026-08-20-with-csv --csv
```

The command may run while the backend is online. It reads a coherent SQLite
snapshot and fails safely if a referenced original disappears or changes while
being inventoried. It never writes to the application database, calls Ollama or
GBIF, runs archive repair, or includes absolute source paths and credentials.
The destination must not already exist and is published only after every
artifact passes internal validation.

The directory contains `archive-metadata.json` and, with `--csv`, `photos.csv`.
JSON is UTF-8 with visible Unicode, explicit nulls, deterministic ID ordering,
canonical UTC archive timestamps, zone-free camera-local capture timestamps, LF
newlines, and no volatile generation timestamp.
For example:

```powershell
python -m json.tool E:\FaunaVaultExports\metadata-2026-08-20\archive-metadata.json
jq '.counts, .photos[0]' E:\FaunaVaultExports\metadata-2026-08-20\archive-metadata.json
```

The CSV uses a documented `\N` null marker and compact JSON arrays for tags. See
[metadata export format v7](METADATA_EXPORT_FORMAT.md) for the complete
field, encoding, relationship, and compatibility contract.

This export is an inspectable metadata and audit artifact only. It contains no
image bytes, has no import/restore guarantee, and does **not** replace a verified
backup containing the SQLite database and complete image payload.

## Backup and recovery

FaunaVault creates self-contained, verified local backup directories. Backups are
deliberately **cold**: stop the backend and keep it stopped for the complete
`create` command. SQLite can provide an online database snapshot, but a separate
image upload or permanent-delete operation could otherwise produce a mixed-time
database and filesystem set.

From `backend`, pass an existing local destination directory:

```powershell
uv run --no-sync faunavault-backup create E:\FaunaVaultBackups
uv run --no-sync faunavault-backup verify E:\FaunaVaultBackups\faunavault-backup-20260812T151500.123456Z-1a2b3c4d
uv run --no-sync faunavault-backup rehearse E:\FaunaVaultBackups\faunavault-backup-20260812T151500.123456Z-1a2b3c4d E:\FaunaVaultRehearsals\recent-backup
```

Creation validates the source archive, snapshots SQLite with its supported
backup API, copies files with streaming SHA-256 checksums, verifies the complete
temporary set, rechecks lifecycle state, and only then publishes it under a
unique name. It never overwrites an existing backup. Warnings such as excluded
orphan files do not make an otherwise recoverable backup invalid; missing or
changed owned files do.

Backup format version 1 is an uncompressed directory:

```text
faunavault-backup-<UTC timestamp>-<id>/
  manifest.json
  database/
    faunavault.db
  images/
    original/
    resized/
    thumbs/
```

The SQLite snapshot contains photos, animals, taxonomy, manual Collections and their
memberships, Smart Collection definitions, schema migrations, and classification jobs. All referenced original, resized, and thumbnail files are
included for both active photos and Trash. Derived variants remain included so
each backup is complete and immediately usable, even though they can now be
regenerated from verified originals. Upload staging, purge journals, SQLite
sidecars, pre-migration database copies, environment files, credentials, caches,
dependencies, and build artifacts are excluded.
Non-empty `.staging` or `.purge` state blocks creation; let normal backend
startup reconcile an interrupted purge, stop the backend again, and retry.

`manifest.json` records only backup-relative payload paths, counts, schema and
format versions, and SHA-256 checksums. Normal backups omit absolute source
paths, and verification never needs the original machine or live FaunaVault
configuration. Checksums detect accidental corruption, not malicious rewriting
of both the payload and manifest. Unexpected regular files are warnings;
symlinks and junctions are rejected and never followed.

### Backup verification and restore rehearsal

`verify` is the fast, read-only integrity check. It proves that the backup
format is supported, the SQLite database matches the schema claimed by the
manifest, and every required payload is present and checksum-valid. It does not
copy files, run migrations, or access configured live storage.

`rehearse` proves that the same backup can be recovered by the current
FaunaVault version. The target must not exist and its parent must already be a
regular local directory. The command verifies the complete source first, copies
only into a uniquely named isolated staging directory beside the target, runs
the real storage initialization and migrations, recovers interrupted running
classification jobs without starting the worker, checks preserved metadata and
albums, and requires a healthy archive-doctor result before publishing the
target. There is no `--force` option.

The successful target is retained for inspection with this logical layout:

```text
<target>/
  data/
    faunavault.db
    faunavault.pre-taxonomy.bak
    faunavault.pre-migrate-*.db  # present when migrations were required
  images/
    original/
    resized/
    thumbs/
    .staging/
    .purge/
```

The pre-migration copies are an intentional consequence of exercising the real
startup path, so allow extra free space for large databases. Rehearsal never
changes `.env`, switches the application to the target, starts Ollama/GBIF, or
processes queued classification jobs. Delete the complete target manually when
it is no longer useful. Periodically rehearse a recent backup as part of the
manual disaster-recovery routine.

Backup container compatibility and database recovery compatibility are separate:

| Backup format | Database schema | Current support | Action |
| --- | ---: | --- | --- |
| v1 | 9 | Supported | Verify, then rehearse/migrate in isolated storage |
| v1 | 10 | Supported | Verify and rehearse with exact Collection metadata and membership checks |
| v1 | 11 | Supported | Verify and rehearse with exact capture-metadata checks |
| v1 | 12 | Supported | Verify and rehearse with exact review-timestamp checks |
| v1 | 13 | Supported | Verify and rehearse with exact Smart Collection definition checks |
| v1 | 14 | Supported | Verify and rehearse with duplicate-pair decisions and scan-state preservation |
| v1 | 15 | Supported | Verify and rehearse with effective capture/GPS, retained extraction, and manual override state |
| Other | Any | Unsupported | Reject before target writes |
| v1 | Other | Not supported until explicitly tested | Reject before target writes |

Schema support is intentionally explicit rather than automatically following
the latest application schema. Before adding schema `N`, existing historical
fixtures must continue to verify and rehearse, migration from every retained
supported schema must pass, and support for `N` must be added with dedicated
tests. Removing recovery support requires an explicit documented decision;
FaunaVault does not promise indefinite support for every historical schema.

### Live archive health and derived-image repair

Archive-wide maintenance is also deliberately cold. Stop the backend and keep
it stopped for the entire command. From `backend`, inspect the configured live
SQLite database and image root with:

```powershell
uv run --no-sync faunavault-maintenance doctor
uv run --no-sync faunavault-maintenance repair-derived
uv run --no-sync faunavault-maintenance repair-derived --apply
uv run --no-sync faunavault-maintenance backfill-photo-metadata
uv run --no-sync faunavault-maintenance backfill-photo-metadata --apply
```

`doctor` is read-only. It checks SQLite integrity, foreign keys and migrations;
active and Trash inventory; safe filenames and lifecycle state; original
SHA-256, size, format, decodability and pixel limits; resized/thumbnail format
and dimensions; perceptual-hash format; and unowned files. It uses a temporary
SQLite snapshot and verifies that the live inventory did not change during the
scan. Ordinary orphan files and directories are warnings and are never deleted.
For schema 11 it also reports partial/invalid dimensions or GPS and a capture
offset without a capture timestamp; it does not compare stored values to EXIF.

`backfill-photo-metadata` is also a stopped-archive operation and defaults to a
dry run. It scans active and Trash Photos by ID, opens authoritative originals
read-only, and fills missing retained extraction and eligible non-overridden
effective capture metadata using the upload extractor.
Capture time/offset, dimensions, and GPS are handled as atomic groups; populated
values and intentional manual clears are never overwritten. `--apply` commits in bounded 25-photo batches and
continues after missing or corrupt originals while reporting their IDs.

`repair-derived` performs the same inspection and defaults to a dry run. It
lists only missing or invalid resized/thumbnail files whose originals pass the
complete trust check. `--apply` is required to write anything. Each new variant
is generated with the upload pipeline's current EXIF, sizing, format and quality
semantics, validated beside its target, and atomically promoted on the same
filesystem. On Windows, a sharing or permission failure leaves the prior target
in place and is reported for retry. Healthy variants and their mtimes remain
untouched; active and Trash photos receive identical protection.

Doctor and derived-image repair never change originals, SQLite rows, original checksums,
perceptual hashes, metadata, taxonomy, classification jobs, or Trash state. A
missing, corrupt, or checksum-mismatched original is not repairable by this tool;
recover it from a separately verified backup. Non-empty `.staging` or `.purge`
state blocks maintenance. Let normal startup reconcile purge state, stop the
backend again, and retry. Recognizable interrupted-maintenance temp files are
reported as warnings and ignored as repair sources.

Exit codes are stable for automation: `0` means the completed archive check is
healthy (warnings are allowed), `1` means errors or repairable defects remain,
and `2` means usage, configuration, or startup I/O prevented a reliable check.
An applied repair finishes with a complete doctor pass and reports success only
when no integrity or repairable findings remain.

### Safe manual production restore

Production replacement remains intentionally manual. `rehearse` never writes to
configured live storage, renames production directories, or selects a backup.
To recover manually:

1. Stop FaunaVault, verify the selected backup, and preferably complete a restore rehearsal with the current version. Do not continue if either check fails.
2. Preserve the current database and complete image root as a separately named fallback. Never overwrite the only current copy.
3. Prefer fresh, empty restore locations. Copy `database/faunavault.db` to the path selected by `DATABASE_URL` and copy the three directories under `images` to the root selected by `IMAGE_DIR`.
4. Update `backend/.env` for those locations. Restore paths do not need to match the machine on which the backup was created.
5. Do not copy staging, purge, sidecars, migration backups, or manifest warnings into runtime storage.
6. Start the backend so normal migrations and startup recovery run. A restored `running` classification job becomes failed for explicit retry; queued jobs retain normal queue behavior.
7. Inspect catalog and Trash counts, Albums, Collections and membership counts, and representative original/resized/thumbnail files.
8. For an end-to-end post-restore integrity check, stop the backend and create a new verified backup of the restored archive in another safe destination.
9. Retain the pre-restore fallback until recovery has been fully validated.

Backup creation does not provide scheduling, retention, compression, encryption,
incremental storage, cloud upload, or remote destinations.

Before schema upgrades, FaunaVault creates timestamped SQLite backups next to the active database. Domestic metadata normalization is schema migration 5, so it is recorded only after successful normalization and safely retried if startup is interrupted. These backups supplement but do not replace full archive backups.

## Troubleshooting

- Ollama unavailable: verify `ollama list` and `curl http://localhost:11434/api/tags`, then retry the failed job. Use an Ollama version that supports the configured vision model.
- Ollama timeout: the 180-second FaunaVault request timeout is configurable for slower hardware, but first inspect the timing log to distinguish model loading, prompt evaluation, and generation. Avoid extreme timeout values that let one Photo occupy the queue for many minutes.
- Ollama runner/model failure: an HTTP 500 is an Ollama-side failure even when its message mentions a load timeout. Inspect the Ollama server log, hardware resources, and model installation; changing FaunaVault's HTTP timeout does not repair the runner.
- Duplicate response: open the referenced catalog photo or use “View Trash” and restore the deleted copy.
- Image rejected: confirm extension, MIME type, actual format, file size, and pixel dimensions agree with configured limits.
- Possible visual duplicate: compare the previews and choose Keep both or Cancel upload; similarity is evidence, not proof of identity.
- Migration failure: keep the backend stopped and inspect the newest `*.pre-migrate-*.db` backup before retrying.

See [docs/IMPROVEMENT_PLAN.md](IMPROVEMENT_PLAN.md) for the audit and prioritized remaining work.

## Photo Favorites and Ratings

Favorite is a personal yes/no choice; Rating is an optional integer 1–5. Null
means unrated. Neither value implies the other or changes AI review state.
Use detail controls, List Favorites/exact/minimum/Unrated filters, rating sorting
(unrated last), or explicit selection bulk actions. Smart Collections save the
same criteria. Map and Timeline retain their limited projection contracts.

Migration 16 adds only the two Photo columns with false/null defaults and
constraints. Existing metadata and historical migrations are preserved. Trash,
restore, capture correction/backfill, and duplicate decisions preserve curation.
Permanent deletion removes it with the Photo. Curation advances `updated_at`,
so an already queued/running AI job can become stale under the existing guard.

Backup format v1 supports schemas 9–16. Schema-16 verification checks curation
column structure and values, including empty databases. Recovery rehearsal
compares Favorite and Rating on active and Trash Photos; older backups migrate
to false/null without rewriting frozen fixtures. Production restore remains
manual and uses the same complete SQLite backup. Portable export v7 includes
JSON boolean/null/integer values and CSV `true`/`false`, 1–5, or `\N`.
