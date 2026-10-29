# FaunaVault operations

Detailed workflows and API behavior for the source-based application. Start with
[Quick Start](../README.md#quick-start). Backend commands below run from `backend`;
root developer commands run from the repository root.

## Nearby Photos

Open an active Photo with a complete, finite GPS pair to see **Nearby Photos**
below Location map. Search within 1, 5 (default), 10 or 25 km. Up to 12 nearest
previews show titles (display title, breed, common name, then original filename),
thumbnail links, distance and optional camera-local capture date. Meters are used
below 1 km and kilometers rounded to one decimal above it. `(0,0)` is valid.
Missing or invalid effective GPS hides the section; extracted GPS is never a
fallback after a manual correction or clear. Distances depend on GPS accuracy and
measure surface great-circle separation, not travel distance or wildlife sightings.

The radius lives in `nearby_radius` in the detail URL. Changes update results
without reloading the detail view, preserve existing `returnTo`, abort obsolete
requests and ignore late replies. Loading, empty, error/Retry and an explicit
unavailable response are handled. Thumbnail links return one hop to the source
Photo with its selected radius. They omit its previous return context to prevent
unbounded nested URLs. The existing **View on map** action stays available.
Map selections are rectangular geographic bounds; Nearby Photos uses a circle,
so those two result sets can differ.

`GET /photos/{photo_id}/nearby?radius_km=5&limit=12` returns:

- `source_photo_id`, `radius_km`, `availability` (`available` or `unavailable`),
  and `unavailable_reason` (`missing_or_invalid_gps`, otherwise null).
- `total`: all active matching Photos within the circle, independent of `limit`.
- `items`: up to `limit` previews with `id`, `thumbnail_filename`,
  `original_filename`, `display_title`, `captured_at`, and `distance_m`.

Allowed radii are exactly 1/5/10/25 km; `limit` is 1–24 (default 12). Invalid query
values return 422. Missing or trashed source Photos return 404, matching active
detail behavior. An active source without valid GPS returns 200 with unavailable
state, zero total and empty items. With no other eligible Photos, available
results are empty. Only effective `Photo.latitude` and `Photo.longitude` are used.

Haversine uses the mean spherical Earth radius **6,371,008.8 meters**. Longitude
differences wrap across the antimeridian, and results include the radius boundary
with a 0.000001 m floating-point tolerance. This spherical approximation does not
correct GPS error or model Earth's ellipsoid. Sort order is exact calculated
distance ascending, effective capture time descending with nulls last, then Photo
ID ascending. Capture time keeps camera-local semantics; offsets are not applied.

Two lightweight SQL projections read source coordinates and candidates within a
conservative spherical-cap bounding box. The latter reuses catalog geographic
predicates, uses longitude OR for antimeridian crossings and all longitudes when
the cap touches a pole. SQLite excludes inactive, missing/invalid GPS and the
source Photo before Python distance checks. Candidates stream in batches of 256;
a nearest-results heap holds at most `limit` entries while every circle match is
counted. Memory is O(256 + limit), with O(candidates × log(limit)) selection work.
Dense areas can still require examining many candidate coordinates. There are no
Photo ORM objects, N+1 queries, image reads, geocoding, new services or migrations.

Results use current archive metadata on each request. Trash removes Photos,
Restore makes them eligible, GPS edits change matching, clearing GPS excludes a
Photo and permanent deletion leaves no references. Clearing source GPS removes
the section after Save. Refresh an open detail after edits made elsewhere; live
cross-tab pushes are not provided. Nearby search is read-only and never changes
originals, derivatives, metadata or preferences. Location map tiles retain their
existing behavior; Nearby search itself needs no tiles or external service.

Focused validation: from backend, `uv run --no-sync pytest
tests/test_nearby_photos.py tests/test_geographic_catalog.py`; from frontend,
`npm test -- __tests__/nearby-photos.test.tsx __tests__/nearby-photos-api.test.ts
__tests__/photo-detail.test.tsx` and `npm run test:e2e -- nearby-photos.e2e.ts`.
Tests use synthetic coordinates and disposable archives, independent reference
distances, desktop/touch mobile and local map-tile responses.

## Camera & Lens Explorer

Choose **Gear** to explore cameras and lenses extracted from imported EXIF.
Only active Photos contribute; Trash removes their contribution and Restore returns
it. Counts and percentages use the entire active archive, even when searching or
paging equipment. Distinct camera/lens model totals count nonblank model strings;
manufacturer-only records appear in camera groups but have no model to count.
Camera groups use the exact trimmed `(camera_make, camera_model)` pair. Differently
spelled or cased values remain separate, and model-only records never acquire an
inferred manufacturer. Labels avoid repeating a manufacturer already in the model.

Click a camera, lens, or missing-equipment total to open List. Independent exact
manufacturer/model/lens criteria combine with AND and with tags, taxonomy,
classification, category, search, Favorites, Ratings, Culling, dates, Import Session
and Trip/Event membership. List and Culling share the validated catalog query and
retain normal counts, sorting and pagination. **Exact equipment** supports individual
removal, clearing all equipment, and missing-camera/lens options. URLs and browser
history retain equipment criteria; changing criteria resets the List page.

Equipment is descriptive imported metadata, not verified identity. Stored strings
and original files stay untouched; comparisons trim Python-style whitespace and
use case-sensitive equality, without substring, brand, or spelling normalization.
A camera is unknown only if both make and model are null/blank; a lens is unknown
if its model is null/blank. Partial information is retained. No external equipment
lookup, AI classification, new tables or migration is involved.

`GET /catalog/gear` returns typed overview totals, `cameras` (make, model, count,
percentage), `lenses` (model, count, percentage), matching `camera_total`/`lens_total`,
`page` and `page_size`. Parameters: `search` (literal substring of equipment values,
up to 200 characters), `sort=name|count`, `page>=1`, and `page_size=1..200` (default
100). Each list is paged independently at the same page/size; the shorter list may
be empty on later pages. Overview totals remain archive-wide. Alphabetical ordering
uses make then model for cameras and model for lenses; most-used sorting adds count
descending first. Binary value tie-breakers keep pages deterministic.

`GET /catalog/photos` and `/catalog/culling` accept `camera_make`, `camera_model`,
`lens_model` (up to 1000 characters), `unknown_camera`, `unknown_lens`. Omit a string
parameter for no criterion; an explicitly empty value selects a missing component.
Gear links include both camera components, using an empty value where absent, so
partial-group links match their displayed counts exactly. Unknown camera plus any
camera component, or unknown lens plus a lens component, returns HTTP 422. Live
equipment criteria are excluded from version-1 Smart Collections; both new saves
and updates are blocked. Map rejects equipment criteria and offers the full List;
Timeline and other archive views keep their existing filtering contracts.

Aggregation uses four scalar/grouped SQL statements, bounded returned rows and no
Photo hydration or N+1 queries. SQLite scans active EXIF fields and groups them in
SQL; trimming expressions and substring option search require scans rather than
raw-column indexes. Cost grows with active archive size; pagination bounds response
and browser memory, not the aggregation scan. A 10,000-photo regression test checks
query count, a generous time budget, deterministic pages and zero Photo hydration.

## Selected photo ZIP export

In List, enter **Select photos**, select individual photos or a page, and choose
**Export selected**. Explicit selection can span pages (maximum 250 photos).
Collection, Trip/Event, Favorites, Rating and Culling filters help curate the
selection; matching a filter never selects or exports every matching photo.
Review the count and estimated size, optionally enable **Include metadata JSON
manifest**, then **Confirm and download ZIP**. Selection and URL filters remain
in place after success or failure. Cancel/Escape closes the dialog before preparation.

The browser downloads `FaunaVault-Export.zip` containing `photos/<id>-<name>.<ext>`
and, when enabled, `metadata.json`. ID prefixes resolve duplicate filenames;
Unicode letters are retained and unsafe member characters are replaced. JPEG
(`.jpg`/`.jpeg`), PNG, WebP, HEIC and HEIF original extensions and bytes are preserved.
No recompression or filesystem paths are included. The manifest uses a separate
`faunavault-selected-photos` version 1 format and contains effective camera-local
capture time, nullable UTC offset in minutes (unknown stays unknown), nullable
GPS, category, classification status, linked verified taxonomy, tags, Favorite,
Rating, Culling state, original filename, ZIP member path and original SHA-256.
Both the manifest and original embedded EXIF can contain GPS. This is a curated
download, **not** the complete archive metadata export or verified backup format.

API (localhost defaults and existing CORS policy are unchanged):

- `POST /exports/selected/estimate` accepts
  `{"photo_ids":[123,124],"mode":"originals","include_metadata":false}`.
  It checks active membership, supported formats, safe regular original paths and
  sizes; returns `selected_count`, `original_bytes`, `estimated_download_bytes`
  and `max_original_bytes`. The estimate includes an allowance for ZIP/JSON overhead;
  preparation validates actual bytes and returns the exact download size.
- `POST /exports/selected` accepts the same body. IDs must be positive, unique
  integers, 1–250 entries; unknown fields and other modes are rejected. All original
  bytes are copied in bounded chunks, checked against recorded sizes/checksums
  when present, and the finished ZIP is read back for CRC/SHA-256 verification.
  A joined metadata snapshot is compared again after preparation; concurrent
  metadata/taxonomy changes or deletion fail the whole export. Once prepared, the
  archive is an immutable snapshot, including if photos change before download.
  Returns `download_path`, `download_bytes`, `expires_in_seconds` (300).
- `GET /exports/selected/<unguessable-token>` consumes that one-use link and streams
  the verified file with an attachment header and known Content-Length. No large
  JavaScript Blob is created. Tokens are local process memory; no table or persistent
  job is created. Keep deployment to the existing single backend worker.
- Structured errors include `export_photo_unavailable`/`export_original_changed`
  or `export_photo_changed` (409), unsafe/missing/unsupported originals (422),
  excessive size (413), export capacity (429), and used/expired tokens (410).
  Refresh/reselect stale photos, fix unavailable originals, or reduce the selection
  and retry. Errors shown before download retain the dialog configuration.

`MAX_SELECTED_EXPORT_BYTES` defaults to **2 GiB of original bytes per export**.
Optional JSON metadata is limited to 8 MiB; an excessive manifest fails with 413.
At most two exports may be preparing, waiting, or downloading per process. ZIPs
use uncompressed storage because the images are already compressed; allow roughly
twice the configured byte limit in OS temporary storage for two concurrent exports,
plus small ZIP/manifest overhead. Files use OS-managed temporary handles and are
deleted on close, after success, failure, interrupted transfer, unused-link expiry,
or backend shutdown. A lost preparation response can retain its unused handle for
up to five minutes. Sequential copying and full verification trade preparation time
and disk IO for a validated archive before the download starts.

The dialog reports **Download requested**, not download completion: browser-native
save/transfer completion is managed by the browser. Check its Downloads list. Links
cannot resume or be reused; prepare another export after an interruption, expiry,
or backend restart. Existing files in the user's download directory are handled by
the browser's normal naming/save prompt; the server never writes to that directory.

## Bulk capture and GPS editing

In List, select up to 250 active photos, choose **Edit capture / GPS**, configure
an operation, and click **Preview changes**. Review each photo's effective values,
override markers and any blockers, check the explicit confirmation, then apply.
Unlike the individual metadata editor, bulk editing always uses this two-step
preview/apply workflow and can restore capture and GPS independently.

- **Shift capture time** adds signed whole minutes to camera-local timestamps,
  preserving relative differences, subsecond precision and each existing offset.
  No timezone conversion occurs. Missing capture timestamps and date overflow
  block the whole operation; deselect those photos or set their capture times first.
  Import timestamps never substitute for unknown capture times.
- **Set capture date and time** validates calendar/leap dates and offers preserved
  offsets, a specific signed offset from `-23:59` to `+23:59`, or explicitly unknown.
  Unknown offsets never silently become UTC.
- **Set GPS** requires both finite coordinates: latitude `[-90,90]`, longitude
  `[-180,180]`. Use **Choose on map** to click/tap a location or drag a marker,
  then **Use this location** to stage that pair for every selected Photo. Numeric
  entry remains available offline. Changing the chosen pair invalidates the preview;
  preview, confirmation, and atomic apply are still required for up to 250 Photos.
  **Remove GPS** clears both; **Clear capture metadata** clears both
  capture timestamp and offset. These intentional clears set independent override
  flags, retain extracted values and prevent EXIF backfills from repopulating them.
- **Restore original metadata** verifies and re-reads original files using the same
  integrity checks as individual restore. Choose capture only, GPS only, or both.
  Only the chosen groups' effective/extracted values and override flags change.
  Retained extracted values are not treated as verified originals. Missing, unsafe,
  corrupted or changed originals block the entire operation. Original metadata may
  itself be empty; restoring an empty group clears its manual override.

`POST /photos/bulk/capture-preview` accepts `photo_ids` and a discriminated `change`:
`{"operation":"shift_time","minutes":120}`,
`{"operation":"set_capture","captured_at":"2024-02-29T12:30:00","offset_mode":"preserve"}`,
`{"operation":"set_capture","captured_at":"2024-02-29T12:30:00","offset_mode":"assign","captured_at_offset_minutes":null}`,
`{"operation":"set_gps","latitude":46,"longitude":14}`,
`{"operation":"remove_gps"}`, `{"operation":"clear_capture"}`, or
`{"operation":"restore_original","group":"capture"}` (`location`/`both` also allowed).
Preview returns the selected, affected and blocked counts, `can_apply`, and ordered
`photos` rows containing before/after values, errors, `updated_at`, and (for restore)
`original_sha256`. It does not write database fields, provenance, or image files.

`POST /photos/bulk/capture-apply` accepts the same IDs/change plus
`expected_versions`, exactly one `{photo_id,updated_at,original_sha256}` from each
preview row. SQLite `BEGIN IMMEDIATE` serializes version validation, calculation,
original verification and mutation with other writers through commit. Missing,
trashed, duplicate or excessive IDs are rejected. Every row must pass; any failure
rolls back the transaction. Structured errors identify affected IDs or row issues.
Stale photo/original conflicts return HTTP 409; resolve issues and preview again.
Failed writes are never automatically retried. Only actually changed photos get
a new `updated_at`; original bytes, AI classification/review, curation, and all
memberships are preserved. No migration or reclassification is involved.

The effective Photo fields continue to drive detail, List filters/sorting, Timeline,
Map, Smart Collections, Trips & Events date suggestions and Wildlife Insights.
The List uses its existing refresh after success; other views read these fields
through their existing queries and refresh behavior.

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

## Development reload and shutdown

Root commands `python scripts/dev.py dev` and `python scripts/dev.py backend`
watch only `backend/app` for backend reloads. Test, documentation, and archive
changes do not trigger a reload. Restart the command after changing backend
environment settings or dependencies.

On Windows, the launcher gives the backend a separate hidden console and keeps
its output in the current terminal. Backend reloads leave the launcher and
frontend running. Ctrl+C in the current terminal shuts down the managed servers
and their workers, including a backend worker created by a reload.

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
`taken_from`, `taken_to`, `favorites_only`, `rating`, `rating_min`, `unrated`,
`sort`, and `order`. Rating criteria are mutually exclusive. Capture-date bounds
are inclusive camera-local dates, and `sort=captured_at` keeps unknown capture dates last.
Responses include the filtered `total`, `total_pages`, and
small global status/category facets. Search is a case-insensitive SQLite
substring search across photo metadata, tags, animal names, and locally stored
taxonomy; whitespace-separated terms must all match somewhere in the record.

Verified taxon choices are loaded separately and in bounded pages from
`GET /catalog/taxa`. Each option uses the stable local `Taxon.id` and includes
its display label, scientific name, and active-photo count. The legacy
`GET /photos` endpoint remains unchanged and still returns the complete active
Photo array for compatible consumers.

The peer archive destinations include List (`/`), Tags (`/tags`), Timeline (`/timeline`), Map
(`/map`), Albums (`/?view=album`), Collections (`/collections`), Review (`/review`),
Duplicates (`/duplicates`), and Trash (`/?view=trash`). Timeline reads a compact,
deterministic `GET /catalog/timeline` projection of active Photos grouped by the
camera-local year and month stored in `captured_at`. Each month shows four
newest-captured thumbnail previews and links to the existing List using its
inclusive `catalog_taken_from` / `catalog_taken_to` URL filters with capture-date
sorting. Photos without capture metadata are reported separately and are never
assigned an import date or fabricated month; JPEG, PNG, WebP, HEIC, and HEIF
participate identically when capture metadata exists.

### Daily Photography Calendar

Open Timeline (`/timeline`) and choose **Calendar**. Timeline's existing year/month
browser remains the default, and both modes share the same archive navigation
entry. `/timeline?view=calendar&year=2026` restores the mode and capture year on
reload and browser Back/Forward. The selector uses available active capture years;
without a year, the most recent available year is selected and saved in the URL.
Switching modes retains the year. Invalid URL years fall back to the latest year;
a valid year without Photos displays an empty twelve-month calendar. With no known
capture dates and no requested year, no data year is invented.

All twelve months use Monday-first calendar grids. Active dates link to List with
the exact same inclusive capture date for `catalog_taken_from` and
`catalog_taken_to`, and `catalog_sort=captured_at`. The shared catalog writer omits
the default descending order. List retains its usual sorting and pagination;
no adjacent dates, old List filters or import timestamps are included. Inactive
dates do not navigate. Full date and Photo count labels support screen readers,
tooltips, keyboard Tab/Enter, and focus indicators; color is supplementary.

Emerald intensity compares daily Photo volume within the selected year. Let
`low = max(1, ceil(max_daily_count / 3))` and
`medium = max(low + 1, ceil(2 * max_daily_count / 3))`. Zero means No Photos;
1 through `low` is Low, `low + 1` through `medium` is Medium, and larger counts
are High. The legend shows the actual count bands. A single exposure always
stays Low, including in sparse archives. Bands can change when selecting years,
correcting metadata or changing Trash, so colors are not cross-year comparisons.

The summary shows this year's active Photo total, distinct active photography
days, average Photos per active day (`total / active days`, or zero), and a link
to the most active day. Equal maximum counts use the earliest date. These are
Photo counts, not wildlife sightings or time spent photographing.

Dates come exclusively from effective `Photo.captured_at` camera-local wall time.
Recorded UTC offsets are never applied to day boundaries. Photos without capture
dates are excluded and counted separately, with a link to Metadata Health.
Use its existing Edit metadata or Restore original metadata workflows; dates are
never assigned automatically. Refresh Calendar after corrections, Trash or
Restore to see new totals. Original images and EXIF remain untouched.

`GET /catalog/calendar?year=2026` is a read-only, typed projection returning:

- `year` (1–9999; null only when no year was requested and no dated active Photos exist).
- `available_years` in ascending order, independent of selection and excluding Trash.
- `photo_count`, `active_days`, `max_daily_count`, and the archive-wide active
  `unknown_capture_count` (independent of selection).
- `days`, chronological `{date: "YYYY-MM-DD", photo_count: N}` totals for active dates.

The sum of daily counts is the selected year's Photo total. At most 366 day rows
are returned, without Photo objects, paths or thumbnails. Two scalar/grouped SQL
queries provide available years and undated counts; a third groups only the
selected year's dates. Substrings preserve camera-local dates without SQLite
timezone normalization. The daily query uses a lower/upper capture range and
the existing `ix_photo_catalog_active_captured (deleted_at, captured_at, id)`
covering index. Year 9999 uses an inclusive `datetime.max` upper boundary.
No image decoding, ORM Photo hydration, N+1 queries, new dependencies or migrations
are needed. Only Calendar mode loads this endpoint; obsolete requests are aborted
and late responses ignored. Aggregates reflect live state on request, not pushed
updates from other tabs.

Focused validation: `cd backend` then
`uv run --no-sync pytest tests/test_photo_calendar.py tests/test_catalog.py`, and
`cd frontend` then `npm run test:e2e -- photo-calendar.e2e.ts`.

#### Existing master smoke baseline

Before this feature, master commit `afcca89061e71dd2f37633b13f6570dffe8a1be7`
already failed [CI run 40846278837](https://github.com/JureZajc/faunavault/actions/runs/40846278837).
Backend, frontend and all three HEIC jobs passed; smoke reported 31 passing and
three failing tests. The job logs show:

- `faunavault-smoke.e2e.ts:48`, Trips & Events: expected 13 Archive views links,
  received 14. Metadata Health added a navigation entry while this assertion
  retained the old count. Calendar adds no navigation entry.
- `metadata-health.e2e.ts:43`, desktop and mobile: after editing GPS and returning
  to List, `No matching records` never appears. Logs show a successful PATCH and
  subsequent List requests with `metadata_issue=missing_gps` but without the
  test's intended `search=metadata-health-...` scope. The likely cause is opening
  the card before the debounced search reaches the URL, leaving other undated/
  missing-GPS fixtures visible. This is an existing search/test timing issue.

Reproduce with `npm run test:e2e -- faunavault-smoke.e2e.ts metadata-health.e2e.ts`
from frontend, using the runner's disposable archive. To isolate the stale count,
use `npm run test:e2e -- faunavault-smoke.e2e.ts -g "Trips & Events"`.
The existing tests and assertions are preserved; these failures are separate
from Calendar coverage and do not require a CI workflow rewrite.

Map has its own `/map` route and reads a lightweight, deterministic
`GET /catalog/map` projection containing only active geotagged Photos and the
metadata needed for markers and previews. Nearby points cluster, exact-coordinate
points remain distinct through spiderfying, and `/map?photo=<id>` focuses a
specific active point. Map shares supported catalog filters but has no bulk selection.

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
Collection, set/unset Favorite, set/clear Rating, or move active photos to
recoverable Trash. Permanent deletion is
never available as a bulk action.

Collections are manually named groups with stable numeric IDs and explicit
many-to-many Photo membership. Create, rename, and delete them under
`/collections`; deleting a Collection never deletes Photos or files. Collection
pages show active Photos in catalog order and support single or selected removal.
Membership survives recoverable Trash and becomes visible again on restore;
permanent Photo deletion removes the corresponding membership rows.

Manual Collections show cover Photos on their cards and detail headers. Use
**Set as cover** on an active member Photo; **Current cover** identifies that
choice. **Remove custom cover** returns to automatic selection: newest active
member by creation timestamp, then ID descending. Empty Collections show a
placeholder. Moving a custom cover to Trash preserves its reference but displays
the automatic fallback; Restore displays it again if membership remains. Removing
the covered membership clears the reference atomically, and permanent Photo
deletion clears it through an SQLite `ON DELETE SET NULL` foreign key. Deleting
a Collection never deletes its Photos or files.

Schema 21 adds nullable `collection.cover_photo_id` with an index. The focused
`PATCH /collections/{collection_id}/cover` endpoint accepts `{ "photo_id": 123 }`
or `{ "photo_id": null }` and returns a Collection summary including the custom ID
and effective lightweight preview. Invalid IDs/payloads return 422, missing
Collections/Photos return 404, nonmembers/Trash Photos and a busy writer return
structured 409 errors. Cover and membership writes acquire `BEGIN IMMEDIATE`
before validation; repeated assignments do not write or change `updated_at`.
Backup-v1 verification accepts covers on active or trashed members, rejects
nonmembers/dangling references, and recovery rehearsal compares cover choices
exactly. Metadata export v12 includes every Collection's nullable cover ID.
Historical backups remain supported; Smart Collection query version stays 1.

Smart Collections are named saved List queries with live membership. In List,
set search, status, category or Unknown, verified taxon, capture dates, Favorites,
exact/minimum/Unrated rating criteria, and sort,
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

## Map filters and List navigation

Photo Map supports the same category (including Unknown), verified Taxon,
classification status, and inclusive camera-local capture dates as List and
Smart Collections. Open **Filters** on Map to combine these criteria. Filters
are stored in the URL; reload, copied links, and browser Back/Forward restore them.
For example:

```text
/map?catalog_category=bird&catalog_taken_from=2026-01-01&catalog_taken_to=2026-12-31
```

**View in List** opens the normal catalog with equivalent filters, including
matching Photos without GPS. **View on Map** in List carries supported filters
and omits pagination, sorting, and layout. Text search and Favorite/Rating filters
are unsupported: List disables this action with an explanation until they are
cleared. A manually constructed Map URL containing those criteria blocks Map
results and offers explicit removal or **View in List**, which retains them.

The mapped-photo count includes only matching active Photos with complete
location data. Manual GPS and capture corrections, clears, and Restore original
metadata use the same effective values as List. Trash Photos remain excluded.
Popup Photo links preserve filters when returning to Map. Filters update cluster
contents without rebuilding the map. Map filters do not save viewport/zoom
or Smart Collection definitions. Geographic selections persist as described below.

### Geographic area selection

Choose **Select area**, then drag a rectangle or tap two opposite corners.
An orange dashed rectangle shows the selection. **Select another area** replaces
it; **Clear area** removes only the geographic criterion. Normal pan/zoom resumes
after confirmation, cancellation, or Escape. Keyboard users can enter all four
bounds in the labeled fields and choose **Apply coordinates**. Errors explain
corrections and return focus to the coordinate inputs.

`GET /catalog/photos`, `GET /catalog/map`, and the List culling source accept
`bbox_south`, `bbox_north`, `bbox_west`, `bbox_east`. Supply all four together:
finite latitude values in [-90,90], longitude values in [-180,180], South < North,
and non-zero longitude width. Equal West/East and West=180/East=-180 are rejected;
West=-180/East=180 explicitly selects all longitudes. A reversed longitude pair
(for example West=170/East=-170) selects across the antimeridian with
`longitude >= west OR longitude <= east`. Latitude and longitude edges are
inclusive. Backend validation rejects incomplete, invalid, NaN, and infinite
coordinates with HTTP 422. Zero coordinates are valid and never treated as absent.

Example API and equivalent persistent browser URL:

```text
/catalog/photos?bbox_south=45&bbox_north=46&bbox_west=14&bbox_east=16
/map?catalog_bbox_south=45&catalog_bbox_north=46&catalog_bbox_west=14&catalog_bbox_east=16
```

Reload, copied URLs, and Back/Forward restore the bounds. Invalid Map URLs show
an actionable error with coordinate editing and clearing, instead of widening
the region. The coordinate summary is approximate; URL values retain numeric
precision. **View selected area in List** carries the bounds and existing criteria
with page reset to 1. Its geographic toolbar indicator supports **Remove area
filter** independently of other filters; Reset filters removes the bounds too.
Return to Map with supported filters to keep the area. Unsupported Map filters
remain explicit, and List links retain them until the user removes them.
Photo popup/detail return links also retain the geographic filter and focus.

Area counts come from the filtered Map response, including empty, loading,
failure, and Retry states. Both Map and area-filtered List exclude Trash and
Photos without complete valid effective GPS. Effective metadata corrections,
Trash, and Restore change membership on refresh. List combines bounds with
tags, equipment, dates, verified Taxon, category, status, Event membership,
rating, Favorite, and Culling filters. An area cannot be saved to a v1 Smart
Collection. No images or original files are read by area filtering.

The shared catalog SQL predicate applies before projection, sorting, counting,
and pagination; no Python archive scan is used. Map still selects scalar columns,
orders by Photo ID, and hydrates no Photo ORM objects. One Map request performs
one SQL query (Event validation adds the existing Event lookup). Clustering and
the map instance are reused; obsolete network requests, draft rectangles, and
selection listeners are cleaned up.

On Windows, a disposable 100,000-record synthetic archive measured approximately
35 ms median for a selective empty bounding box and 317 ms for a whole-world
area returning 33,287 points (seven warm iterations, service time, no HTTP/image
cost). `EXPLAIN QUERY PLAN` used `ix_photo_deleted_at` to restrict active rows;
the current schema has no GPS index. These measurements do not justify a new
index or migration. Larger outputs still cost proportionally to returned points.

## Exact and possible visual duplicates

### Photo Compare (v0.3)

Compare exactly two active Photos:

- In List, enter **Select photos**, explicitly select two (including across
  pages), and click **Compare**. Other selection counts disable Compare.
- In Duplicate Review, click **Compare** for the current candidate pair.
- In Culling, use **Compare with next**, or **Compare with previous** at the
  end. A source with no neighbor cannot open a comparison.

The route `/compare?left=<id>&right=<id>` restores the same pair on refresh or
when copied. Entry links include a local return URL. Returning to List preserves
the applied filters, sort, layout, and page and clears selection. Leaving Culling
resets its transient session history, as for Photo detail. Invalid or identical
IDs show an explanation; unavailable Photos leave the surviving pane usable.

Desktop (1024 px and wider) shows two large panes. Narrower screens use **Focus
left photo** / **Focus right photo** to switch between them without discarding
their viewing state. Each side includes filename/title, camera-local capture time
with seconds and recorded offset, dimensions, filesize, category/species,
camera/lens, GPS availability, and curation. Neutral “Differs” indicators compare
metadata; larger files or dimensions do not imply a better Photo.

Images initially use the normal preview (up to 1600 px), or a thumbnail when its
resized filename is missing. Each pane has independent Fit/reset, 1–4× fitted
zoom, pointer-drag/scroll panning, and directional pan buttons. **Load original
resolution** explicitly requests a JPEG/PNG/WebP original; the preview stays
visible while loading and on failure. HEIC/HEIF keeps its JPEG preview. Fit/reset
resets zoom and pan; **Use preview** switches back after original inspection.
Zoom is relative to fit, not a promise of one source pixel per display pixel.

Pick, Reject, Clear decision, Favorite/Unfavorite, and Rating 1–5/clear use the
normal guarded Photo edits. They remain independent, never affect the opposite
side, and do not advance to another pair. Compare has no Trash or permanent
deletion controls. Duplicate Review retains authoritative evidence and **Keep
both / Not duplicates** or Trash resolution; return there to resolve the pair.

Clicking or focusing a pane activates its shortcuts. **Left/Right arrows** select
the active side; **P** picks, **X** rejects, **U** clears its culling decision,
**F** toggles Favorite, **1–5** sets Rating, and **0** clears Rating. Typing,
modifiers, held-key repeats, and modal dialogs suppress shortcuts. Native controls
and image viewport arrows retain their normal navigation/scroll behavior. Every
shortcut has an accessible control identifying its target side.

Compare refreshes on focus/visibility, explicitly through each **Refresh** button,
and every 30 seconds while visible, without overlapping requests or saves. A
conflicting edit reloads confirmed state and requires another explicit action.
Refresh failures identify stale state and disable edits until refresh succeeds.
Photo detail APIs deliberately return the same unavailable response for Trash
and permanent deletion. Changes use the same state as List, Culling, Photo detail,
and Smart Collections. No winner selection, scoring, automatic alignment,
synchronized zoom, image editing, new backend endpoint, or archive scan is added.

### Duplicate Review Center

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
SQLite. The current schema (16 for v0.2.0) must already be initialized by normal
startup; the command does not migrate storage. Safe configured
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
their preservation. Backup v1 and historical schemas 9–21 remain supported.
Portable metadata export v12 intentionally excludes duplicate curation state; use
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
reverse geocoding, place search, tile downloader, analytics,
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
read-only. Bulk editing uses the separate preview/apply workflow documented above.
There is no geocoding or timezone lookup.

For a location, choose **Choose on map** in the metadata editor. Click/tap to place
the marker or drag it to refine a point, then review the live coordinates and
choose **Use this location**. Existing GPS initializes the map and marker; a Photo
without GPS starts with an unselected world view and requires an explicit point
or complete numeric pair. This only changes the form draft. **Save** persists the
location with the editor's version check; editor Cancel discards it. Picker
Cancel/Escape discards only the unconfirmed picker changes and restores focus.

Latitude and longitude are editable by keyboard both in the editor and picker,
including negative values, `0,0`, and boundary coordinates. Values keep JavaScript
number precision without decimal rounding. Map clicks across repeated world views
normalize longitude to `[-180,180]`; the Mercator basemap cannot depict the exact
poles, but numeric entry accepts ±90°. GPS selection never changes capture times
or UTC offsets. No device location permission, tracking, or reverse geocoding is
used. Loading map tiles may contact the configured external provider in
`frontend/app/lib/map-config.ts` (OpenStreetMap by default); tile coordinates reveal
the viewed area, without sending photo metadata or filenames. Manual coordinate
entry and confirmation remain usable if offline or if map loading fails.

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
preserves both corrections and provenance. Backup-v1 schemas 9–21 are supported;
verification/rehearsal preserve all new fields. Portable JSON/CSV export v12
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
[metadata export format v9](METADATA_EXPORT_FORMAT.md) for the complete
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
| v1 | 16 | Supported | Verify curation structure and values; rehearse with Favorite/Rating preservation and safe older-schema defaults |
| v1 | 17 | Supported | Verify and rehearse independent Photo culling state |
| v1 | 18 | Supported | Verify session structure, membership, and historical totals; compare sessions and Photo provenance exactly during rehearsal |
| v1 | 19 | Supported | Verify and rehearse Trips & Events and their memberships |
| v1 | 20 | Supported | Verify and rehearse custom Event covers, including Trash members |
| v1 | 21 | Supported | Verify and rehearse custom Collection covers, including Trash members |
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
It also validates capture dimensions, effective/extracted GPS and date/offset
groups, override markers, duplicate-pair/scan state, and Favorite/Rating structure
and values. It does not compare stored values to EXIF or discover duplicate pairs.

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

## Import Sessions and Recent Imports (v0.3)

An Import Session records one intentional ingestion operation: one submitted
browser file selection or one real offline folder-import invocation. It records
origin and aggregate history. Curation, duplicate decisions, and classification
jobs continue to use ordinary Photo metadata and their existing workflows.

Open **Recent Imports** from the upload panel, List toolbar, or Culling context.
The existing nine archive navigation items remain unchanged. `/imports` shows
24 sessions per page, newest first with a stable UUID tie-break. Each card shows
source/date, optional folder label, original imported total, reported outcomes,
current active/Trash totals, and active-only undecided/Pick/Reject counts.

**View imported photos** opens the existing List at
`/?catalog_import_session_id=<uuid>`. Sorting, search, taxon/category/date and
curation filters compose with membership; reload and copied URLs preserve it.
Selection resets when the source changes. Detail, Compare, Favorites/Ratings,
bulk actions, and rejected cleanup use their ordinary controls. Clearing filters
also clears session membership. Smart Collection query version 1 can save/edit
the optional `import_session_id` without changing historical saved queries.
Map currently rejects session criteria and List explains its disabled Map action.

**Cull this import** opens the existing `source=list` Culling workspace using
only session membership and default newest-first ordering, including every active
Photo from that import. Ordinary **Open in Culling** preserves additional List
criteria. Contextual **Review rejected** combines the session with Reject;
**Review all rejected photos** explicitly opens archive-wide review. Live counts
refresh after relevant changes and when returning to the session List.

The browser starts a client-generated UUID before sending its existing sequential
per-file requests. Keep both and retry retain the same UUID. A separate selection
or tab starts a different session. Only saved Photos become members. The queue
finalizes after requests and visual reviews drain, even if some files failed.
Retry reopens the same session and replaces final outcome counts while preserving
its start and original imported total. Session-start and completion failures have
separate **Retry import session** controls; completion retry never uploads files
again. Completion shows View/Cull actions without automatic navigation.

`completed_at: null` displays **Not finalized**, covering active, abandoned, or
interrupted operations without implying a background job. Unavailable outcome
counts stay null. A lost upload response can produce a reported queue failure
although the server already saved that Photo: the transactional original imported
total and membership are authoritative. Empty sessions remain in history and
offer no Photo actions. Partial successful files remain saved after interruption.

The folder importer creates one session after successful preflight, commits
successful files independently, finalizes from its existing summary, and prints
`Session: <uuid>`. It still runs with the backend stopped; the session appears in
Recent Imports after startup. `--classify` queues jobs independently of session
completion. `--dry-run` creates no session, Photo, job, migration, or archive file.

Folder labels retain only the validated directory basename, stripped of controls
and path separators and bounded to 200 characters. Browser display labels derive
from source kind and date. No absolute path, parent directory, failed source
filename, or attempt log is persisted or exported. Source files remain untouched.

Schema 18 adds `import_session` and nullable indexed `Photo.import_session_id`
with a real foreign key; existing Photos stay null without inferred history.
Ordinary Photo edits cannot change provenance. Original imported totals increment
in the Photo transaction. Trash/restore retains membership, active culling counts
exclude Trash, and permanent deletion retains the session and historical total.

Metadata APIs are `POST /import-sessions` with `{id: <uuid>}`, idempotent
`POST /import-sessions/{id}/complete` with four nonnegative aggregate outcome
counts, `GET /import-sessions` (default 24, maximum 100), and
`GET /import-sessions/{id}`. Upload endpoints accept optional multipart
`import_session_id` and reject unknown or wrong-source identities before file
promotion. Standalone requests create one session each; compatibility batches
create one and return it. Pending visual review leaves it unfinalized, and
resolution requests can reuse that reference. Identical repeated completion
preserves its original timestamp. A different summary requires reopening first.

History performs one grouped Photo query restricted to the requested page of
session IDs; detail groups one ID. Metadata browsing reads no Photo IDs, images,
or files. The membership index also narrows List and Culling queries. Backup v1
keeps its manifest shape and supports schemas 9–21, including session signatures
for change detection and exact recovery comparisons. Portable export v12 includes
ordered sessions, historical aggregates, nullable membership, and CSV provenance;
derived culling counts are omitted. See [the export contract](METADATA_EXPORT_FORMAT.md).

There is no session-management UI, expiry, source synchronization, watching,
scheduling, background ingestion, or automatic Collection creation.

## Photo Culling (v0.3)

Open **Culling** to review active Photos with no culling decision, newest added
first. **Open in Culling** on List uses the complete current query and sort,
including any Favorite, Rating, or culling filters; page, grouping, and explicit
selection do not restrict this read-only queue source. Back to List restores the
original List URL. Recent Imports uses this same List-source mechanism; direct
manual Collection sources are not yet offered.

Use **Pick**, **Reject**, or **Clear decision**. Pick and Reject advance only
after a successful save; Clear stays on the current Photo. Next can skip without
making a decision. Previous revisits decisions made during the session, including
Photos that have left the undecided query. History is in memory and resets when
you reload, leave Culling, or change the source; copied URLs retain criteria and
the current Photo. Open Photo detail for normal Favorite/Rating and metadata edits.

Visible shortcuts are **P** for Pick, **X** for Reject, **U** for Clear, and
Left/Right arrows for navigation. Shortcuts ignore text inputs, editable content,
modifiers, key repeat, and open dialogs/lightboxes. Native arrow controls retain
their behavior. No simple key moves Photos to Trash or permanently deletes them.

Counts describe the live matching source and decisions in this session. At the
end of a pass the last Photo remains visible; Previous can revisit it and Restart
queries the source again. Skipped Photos stay undecided. Empty sources show an
explicit empty state. Failed saves retain confirmed state; retry explicitly.
Conflicts refresh the current Photo without automatically submitting the decision
again. A saved decision followed by a queue-refresh failure is reported separately.

These concepts are independent: Favorite means personally important/liked,
Rating is a personal 1–5 score, Pick selects during culling, Reject does not select
during culling, and Trash controls the deletion lifecycle. A Favorite Pick, a
three-star Pick, or a five-star Reject are all valid. Reject stays active in the
archive. Culling changes do not accept AI classification, change `needs_review`
or `reviewed_at`, or enqueue work. They update `updated_at` when changed, so the
existing guard may reject an AI result queued against older Photo metadata.

List supports All/Picked/Rejected/Undecided structured filters and restores them
from URLs and browser history. Smart Collections save the same criteria: for
example Picks from 2026, Favorite Picks, or five-star Picks. Select explicit Photos
and use **Culling decision** for Mark Pick, Mark Reject, or Clear culling decision
in bulk (maximum 250). A change in criteria resets selection. Card and duplicate
indicators are display-only; human duplicate decisions remain authoritative.
Map rejects unsupported culling filters and provides an explanation and List link.

Schema 17 stores `culling_state` as null, `pick`, or `reject` with a database
constraint. Existing Photos start null. Trash and restore preserve the field;
permanent deletion removes it with the Photo. No automatic Trash/expiry is added.
Portable export v12 includes decisions on active and trashed Photos: JSON uses
null/`pick`/`reject`; CSV uses `\N`/`pick`/`reject`. Backup format v1 supports schemas
9–21, verifies column structure and values, checks live metadata changes before
publication, and compares decisions during isolated recovery rehearsal. Historical
backups upgrade to undecided. Production restore remains manual.

## Rejected Photo Review and Cleanup (v0.3)

Choose **Review rejected** in List or Culling, including at the end of a pass.
This opens List with only the Reject filter (`/?catalog_culling_state=reject`),
newest added first; source search, filters, sort, grouping, page, and Smart
Collection editing context are cleared. Reject is a curation decision, not
deletion. Membership is always active Photo plus `culling_state=reject`; there
is no saved cleanup queue.

The count comes from the normal paginated catalog. Other List filters can narrow
review; the count then says **matching current filters**. An empty unqualified
query says **No rejected photos need cleanup**, which says nothing about Trash.
An empty narrowed query offers **Review all rejected photos**. Resetting filters
or changing away from Reject returns to the usual List presentation.

Open a card for Photo detail and its fullscreen viewer before cleanup. Choose
**Select photos**, then check explicit Photos or **Select page**. Selection can
span pages up to 250 IDs; it never silently selects all matching results. Page
and layout changes retain selection; criteria/sort changes, successful bulk
actions, and leaving List clear it. **Culling decision** can mark Pick or clear
a mistaken Reject; those Photos leave the rejected results after refresh.

Exactly two selected Photos enable the existing **Compare** action. Pick,
Reject, Clear, Favorite, and Rating remain independent per side. **Back to List**
preserves the rejected query, additional filters, sort, layout, and page, reloads
membership, and clears selection. A page that no longer exists is corrected.

**Move selected to Trash** requires a count-bearing confirmation, including for
one Photo. Only the explicitly selected IDs are submitted. Cleanup checks all
IDs within one write transaction: missing or already-trashed Photos, or a Reject
changed to Pick/Undecided in another tab, abort the whole request. No Photos move
on these conflicts. The dialog retains selection and reports the error; choose
**Refresh rejected photos** to close it, clear selection, and reload before
selecting again. Refresh does not retry the mutation. Other failures retain the
dialog for explicit retry; a successful mutation with a failed catalog refresh
is reported separately.

Trash remains recoverable through the existing **Trash → Restore** flow. Restore
returns a Photo to rejected review if its decision remains Reject. Favorites,
Ratings, capture metadata, classification status, and `reviewed_at` survive
Trash/restore. Favorites and high Ratings do not block an explicit Trash choice;
there is no additional conditional warning. Cleanup does not accept AI review or
enqueue classification; existing Trash behavior cancels active classification
jobs. Duplicate candidates disappear while either Photo is in Trash and
unresolved pairs return on restore; dismissed decisions remain preserved.
Rejected Smart Collections update dynamically without definition changes.

Cleanup uses `POST /photos/bulk` with `operation=move_to_trash`, explicit
`photo_ids`, and optional `expected_culling_state=reject`. The rejected-review
UI always supplies the precondition; existing callers without it retain ordinary
bulk Trash semantics. A decision mismatch returns HTTP 409 `photos_not_rejected`
with the mismatching IDs. Other metadata changes alone do not block cleanup.

No individual Trash buttons are offered on rejected-review cards; inspection
continues through existing Photo detail. Permanent deletion stays inside Trash
with its existing confirmation. There is no automatic selection, Trash,
permanent deletion, retention, scan, background job, or scheduling. Schema 17,
export v12, and backup v1 remain unchanged.

## Photo Favorites and Ratings

Favorite is a personal yes/no choice; Rating is an optional integer 1–5. Null
means unrated. Neither value implies the other or changes AI review state.
Use detail controls, List Favorites/exact/minimum/Unrated filters, rating sorting
(unrated last), or explicit selection bulk actions. Smart Collections save the
same criteria. Map and Timeline retain their limited projection contracts.

Use the Favorite toggle and five-star Rating control on Photo detail without
entering metadata edit mode. Clear rating returns the Photo to unrated. Native
radio controls support keyboard rating changes; cards and duplicate comparisons
show compact indicators. List criteria survive copied URLs, reload, and browser
history. Select explicit Photos to Favorite/Unfavorite or set/clear ratings in bulk.

Migration 16 adds only the two Photo columns with false/null defaults and
constraints. Existing metadata and historical migrations are preserved. Trash,
restore, capture correction/backfill, and duplicate decisions preserve curation.
Permanent deletion removes it with the Photo. Curation advances `updated_at`,
so an already queued/running AI job can become stale under the existing guard.

Backup format v1 supports schemas 9–21. Schema-16 verification checks curation
column structure and values, including empty databases. Recovery rehearsal
compares Favorite and Rating on active and Trash Photos; older backups migrate
to false/null without rewriting frozen fixtures. Production restore remains
manual and uses the same complete SQLite backup. Portable export v12 includes
JSON boolean/null/integer values and CSV `true`/`false`, 1–5, or `\N`.

## Trips & Events (v0.3)

Open **Trips & Events** beside Collections. Create a Trip (the default) or Event
with a title and explicit start/end dates. Both types permit one or several days.
Titles normalize whitespace and allow duplicates (100 characters); optional
location labels allow 200 characters and notes 2,000. Blank optional fields become
null. Notes retain line breaks and render as plain text.

The URL restores All/Trips/Events and index pages, ordered by newest start date
then ID. Each page uses grouped counts and at most four ranked active-member
previews. Detail uses a grouped active/Trash/undecided/Pick/Reject aggregate and
normal catalog pagination (48, newest added first). Select across pages for safe
removal or select exactly two for Compare. Delete and removal confirmations
focus Cancel and explicitly preserve Photos. Deleted Event IDs are never reused.

**Add Photos** opens ordinary List with `add_to_event=<id>` and a target banner;
it does not filter by existing membership. **Add suggested photos** initializes
inclusive effective camera-local capture dates. Missing dates and Trash never
appear in suggestions; import/creation dates are never substituted. Copied URLs
retain those visible date filters. **Use current Trip/Event dates** explicitly
refreshes them and clears selection. Select 1–250 active Photos, then click
**Add selected to this Trip/Event**. Successful batches clear selection and remain
in List; existing memberships are reported idempotently. Ordinary List selection
also offers a paginated **Add to Trip/Event** target dialog. Invalid/deleted
targets block adding and offer retry/navigation.

**View in List**, **View on Map**, and **Cull this Trip/Event** preserve explicit
membership through `catalog_event_id`, filters and return navigation. Map shows
only active members with effective GPS; existing unsupported-filter explanations
still apply. **View date range in List** shows every date-matching archive Photo,
including nonmembers, using the existing Timeline date-navigation behavior.
Recent Imports reaches the same addition action through its scoped List.

From a card in **Recent Imports**, or the contextual Import Session card in List,
choose **Create Trip/Event**. Trip is the default; a safe import label may suggest
the title, while location and notes start empty. The refreshed Import Session
supplies the earliest/latest effective camera-local capture dates and counts of
active photos with/without dates. These are recommendations: review and accept
the proposed range or edit it before creation. Partially dated imports show the
unknown count; completely undated imports require both dates manually. Import
timestamps never replace missing capture dates, and Trash never contributes.
Sessions with no available photos explain why assignment is unavailable.

After creation, List retains `catalog_import_session_id=<session UUID>` and
`add_to_event=<new Event ID>` without filtering by the empty Event's membership.
Existing valid List criteria are retained; the old Event scope and page are reset.
Choose **Select Photos to add**, select across pages (at most 250), choose
**Add selected to this Trip/Event**, then **Confirm add photos**. Only the selected
active photos are added; missing or trashed selections reject the whole request.
Success clears selection and provides an Event link. **Recent Imports** returns
to import history; browser Back restores the originating history URL/page.

Creation and membership are separate actions. Canceling the form creates nothing;
canceling selection or its confirmation preserves the created Event. Failed saves
retain edited input. A successful creation stores its ID before navigation and
offers continuation/Event links if navigation fails, preventing navigation or
membership failures from submitting creation again. Dates are read-only grouped
SQLite suggestions on the existing session API (`earliest_capture_date`,
`latest_capture_date`, `dated_count`, `undated_count`); no table, migration, job,
automatic memberships, original-file changes, or backup/export format changes.

Dates never assign Photos or change existing memberships. A Photo can belong to
several Trips, Events and Collections. Metadata/membership edits update only the
Event timestamp; Photo timestamps, classification, AI review and duplicate
decisions stay independent. Event criteria cannot be saved as Smart Collection
query v1; clear membership scope to save a date/metadata query. Trash retains
joins; Restore makes active members reappear. Permanent Photo deletion cascades
join rows and leaves the Event, even when empty.

The typed `/events` API has paginated GET (24 default, 100 maximum, optional kind),
POST, and `/events/{id}` GET/PATCH/DELETE. POST/DELETE
`/events/{id}/photos` accept 1–250 distinct positive integer IDs. Duplicate IDs
fail validation, missing Photos fail the entire request, adding Trash conflicts,
and repeat additions/removals are idempotent. PATCH validates the merged date
range. `/catalog/photos`, `/catalog/map` and `/catalog/culling` accept runtime
`event_id`; malformed IDs fail validation and absent Events return 404.

Migration 19 appends two empty tables to older archives without rewriting
historical migrations. Backup v1 supports schemas 9–21 with its unchanged
manifest. Schema-19 verification checks columns, composite keys, cascading
foreign keys, metadata constraints, reverse index, canonical data and references,
even with empty Event tables, before rehearsal writes. Deterministic Event and
membership signatures detect concurrent backup changes and verify exact recovery.
Older backups migrate to empty Event tables. Rehearsal output includes Event and
membership totals. Portable export v12 includes all Event fields and Trash joins,
ordered with validated references; photos.csv is unchanged.

Recurrence, automatic membership, Event coordinates and geocoding remain deferred.


### Custom Trip/Event covers

Open a Trip/Event and click **Set as cover** on an active member Photo. This saves
immediately, updates the header, and marks the Photo **Current cover**. The index
shows the same cover. **Remove custom cover** restores automatic selection.
Cover buttons are separate from membership selection, prevent duplicate saves,
and report errors with refreshed Event/member data. Pagination stays in place.

Automatic covers use the newest active member by `created_at DESC, id DESC`,
including deterministic ID ordering when timestamps tie. An Event with no active
members shows an empty placeholder. Covers display existing thumbnails, without
copying images, changing original bytes, or loading full-resolution originals.

- Trash retains `cover_photo_id` but hides that Photo; the next active member is
  displayed automatically. Restore reactivates the cover if membership remains.
- Membership removal clears the cover in the same transaction. Re-adding the
  Photo does not silently select it again.
- Permanent Photo deletion clears the reference; Event deletion removes the
  Event and memberships while retaining all Photos.

`PATCH /events/{event_id}/cover` accepts `{"photo_id": 123}` or
`{"photo_id": null}` and returns the updated Event detail. Summary/detail responses
include the saved `cover_photo_id` and visible `cover_photo` (ID, thumbnail
filename, original filename and optional display title). The visible cover may
be an automatic fallback while a saved cover is in Trash. Missing Events/Photos
return structured 404 errors; inactive or nonmember selections return structured
409 errors; malformed requests return 422. Unchanged selections do not write or
advance `updated_at`. SQLite writer locking serializes cover validation and
membership changes, with a retryable 409 when the archive is busy.

Append-only schema 20 adds nullable `archive_event.cover_photo_id`, an indexed
Photo foreign key with `ON DELETE SET NULL`. The startup migration creates its
usual pre-migration database backup. Historical schemas 9–19 remain supported;
backups at schema 20 preserve covers, including references to Trash members.
Backup container format remains v1. Verification checks the cover column, foreign
key, index and explicit membership, and backup creation detects concurrent cover
changes. Restore rehearsal compares complete cover metadata; older Events
normalize to no custom cover. Portable metadata format 11 includes the nullable
saved reference, including hidden Trash covers, in authoritative Event JSON;
`photos.csv` is unchanged. See [the export contract](METADATA_EXPORT_FORMAT.md).

## Wildlife Insights

Open **Insights** in Archive navigation (`/insights`). All metrics describe active
photos; Trash is excluded, including active photos marked Reject. Favorites and
Pick/Reject are independent photo counts, so they do not partition the total.

- **Active photos**: image records in the selected period, regardless of category,
  classification, or taxonomy. All Time includes undated photos. A capture year
  includes only effective `Photo.captured_at` values in that camera-local year.
- **Verified species**: distinct linked local Taxon IDs at `SPECIES` rank through
  Photo → Animal → Taxon, using the same linked-taxonomy definition as Albums.
  Species guesses and unlinked legacy names do not count. Linked genera, families,
  subspecies, and other ranks are reported separately and excluded from species.
- **Top Species**: ten species ranked by active photo count, then scientific name
  (SQLite NOCASE), then Taxon ID. Multiple photos of one Animal and photos of
  multiple Animals sharing a Taxon each count once. Common names are preferred;
  scientific names are the fallback. Photos without linked taxonomy are reported
  separately. These are image counts, not counts of animals or wildlife observations.
- **Coverage**: known and missing counts sum to the period's active total. GPS
  requires both latitude and longitude within valid ranges (zero is valid).
  Capture dates use effective values, including user corrections. Neither import
  nor creation time fills missing capture dates. Stored offsets never shift the
  camera-local grouping. Clearing or restoring metadata updates subsequent reads.
- **Categories**: named categories plus Uncategorized (null, empty, or space-only).
  The twenty most photographed named categories are shown, with an exact Other
  categories remainder if needed to keep the response bounded.
- **Classification**: Pending, Classified, and Needs Review use existing statuses.
  Unclassified/pending photos still belong to all applicable totals. Unexpected
  legacy statuses appear as Other status so the distribution reconciles.
- **Top Cameras / Top Lenses**: ten most-used manufacturer/model pairs and lens
  models, respectively. The existing Explorer/List convention trims surrounding
  whitespace, preserving case and spelling. No guessed brand identity merges
  groups: manufacturer-only and model-only cameras remain distinct. Rankings use
  photo count descending, equipment name ascending (SQLite NOCASE), then exact
  component values to break ties. Unknown groups stay outside the Top 10.
- **Equipment coverage**: a camera is identifiable if either manufacturer or model
  is nonblank; a lens requires a nonblank lens-model field. Both known and missing
  shares use the entire selected period's active Photo total. Missing EXIF can
  reflect absent camera metadata, export stripping, or unsupported metadata; it
  does not identify a particular device. Equipment links filter exact stored
  criteria (including explicitly missing components), and unknown links use
  existing unknown-equipment filters. Both retain the capture-year range in List.

All percentages use the selected period's **entire active photo total**, rather
than just dated, GPS-tagged, classified, or verified photos. Empty denominators
produce 0%. API percentages round to two decimals; display uses at most one, so
rounded shares need not sum to exactly 100%.

All Time activity shows chronologically ordered yearly counts; selecting a year
shows all twelve months with explicit zeros. Undated photos appear separately and
never enter a chart bucket. Month/year links open the existing List for inclusive
capture dates. Species/category/status links retain the selected capture year and
use existing catalog URL parameters. Other remainder groups have no synthetic
filter link. **View on Map** opens the existing Map with the capture-year filter;
Insights performs no geocoding, location naming, remote analytics, or tracking.

`GET /insights?year=2026` is read-only; omitting `year` selects All Time. Years
1–9999 are valid, unknown valid years return an empty period, and invalid years
return HTTP 422. `available_years` always describes the entire active archive;
all overview and distribution fields are scoped. `yearly` contains scoped capture
years; `monthly` is empty for All Time and twelve entries for a selected year.
The additive typed `equipment` object contains `camera` and `lens` coverage
(`known`, `missing`, `percentage`) and bounded `top_cameras` / `top_lenses`.
Camera rows contain nullable `camera_make` / `camera_model`, `photo_count`, and
`percentage`; lens rows contain `lens_model`, `photo_count`, and `percentage`.
Existing response fields and metric definitions remain unchanged.
The page's `year` URL parameter is restorable; an invalid page value visibly falls
back to All Time. Fetch failures provide Retry; switching years cancels old
requests and ignores late responses.

**Compare with** is optional and requires an explicitly selected second capture
year different from the primary. `/insights?year=2026&compare=2025` restores both
years after reload or browser Back/Forward. All Time is never a comparison year.
Invalid URL comparisons show an explanation; choosing All Time or making the
primary equal the comparison clears it. Valid years with no active Photos show
an empty period. The comparison reuses `GET /insights` for each year, reusing the
already-loaded primary response. Loading and retry are independent; cancelled or
late responses cannot show a previously selected year's metrics.

The comparison shows active Photo total, distinct linked verified species-rank
taxa, Favorite/Pick/Reject Photos, and GPS coverage for each year. Differences
are primary minus comparison. Count changes also show relative percentages when
the comparison value is nonzero; a zero baseline displays `N/A` without dividing
by zero. GPS differences are **percentage points**, not relative percent changes.
Verified species totals do not identify newly observed species, unique sightings,
or individual animals. Year links open that year's canonical filtered List.

The service uses seven aggregate queries for All Time and eight for a selected year,
without loading Photo objects or reading images. Existing relationship/capture
indexes are reused. Year rows are bounded by the 1–9999 calendar; species and
category and equipment results have fixed limits. Equipment coverage shares the
overview query; two grouped queries return bounded Top 10 lists. There is no migration, cache, analytics DB,
new chart dependency, or AI reclassification. Counts refresh on navigation/reload,
not through live polling. Detailed geographic aggregation, heatmaps, and
observation/deduplicated-animal inference remain outside this first version.

For a disposable performance check, run from `backend`:

```sh
uv run --no-sync python -m app.cli.benchmark_insights --sizes 100000 --runs 20 --output ../insights-benchmark-results.json
```

This reuses the catalog benchmark's protected-location checks, deterministic
synthetic dataset, production storage initializer/indexes, owned temporary
database cleanup, and exclusive new-report publication. It never opens the live
archive or reads original images. An independent in-memory oracle verifies
population, distinct species, equipment counts/coverage/percentages, ranking
counts/order, and breakdown reconciliation. Query counts are asserted exactly.
`--verbose` prints emitted SQL and query plans. Choose a fresh output filename.

Before equipment analytics, 100,000 synthetic photos (95,000 active) produced
2,550-byte All Time and 2,608-byte 2026 responses. Across 20 warm-cache service
calls, All Time median/p95 were 220/228 ms with five queries; 2026 median/p95 were
139/167 ms with six queries and 5,935 matching photos. These measurements exclude
HTTP, JSON encoding, browser rendering, and cold disk reads. All Time joins reuse
the catalog's active-ID lookup pattern to avoid reading wide rows in capture-index
order; selected years retain the selective capture-index range scan. No new index
or planner hint is required. Timings depend on machine and archive distribution.

With equipment analytics, a disposable 100,000-Photo run (20 warm-cache calls)
measured All Time median/p95 at 542/609 ms with seven queries, and 2026 at
200/276 ms with eight queries and 5,935 matching Photos. Response sizes were
2,869 and 2,921 bytes. Gear rankings reuse the sequential active-ID lookup for
All Time and the existing selective capture index for a selected year. These
service timings exclude HTTP, JSON encoding, browser rendering and cold reads;
background load and archive equipment diversity can change the results.

## Fullscreen gallery and slideshow

In a Manual Collection, choose **Open gallery** to start with its first active member.
In a Trip/Event, **View gallery** starts at the custom cover if active, otherwise the first
active member. **View in gallery** on a member card starts from that Photo. Membership is
explicit; Event dates do not determine gallery contents. Gallery actions do not change covers
or memberships. Photos in Trash are excluded when loading pages.

Use the touch-friendly Previous/Next buttons, or Left/Right arrows with focus in the viewer.
Escape closes and returns focus to the opening control. Tab and Shift+Tab cycle through gallery
controls. Inputs and controls keep their usual keyboard behavior; gallery keys do not trigger
Culling actions behind the overlay. Captions and a position counter accompany resized images.

Choose **Play** to begin; playback never starts automatically. Choose an interval of 3, 5
(default), or 10 seconds, and **Pause** to stop. Playback waits until each image loads, stops
at the final image, and pauses on an image/page error or when the browser tab becomes hidden.
Returning to the tab requires Play again. Manual navigation pauses playback. Closing clears
playback and pending requests. Reduced-motion preferences disable image transitions.

Large Collections and Events load 48-member pages on demand and retain no more than three
pages. Gallery navigation leaves the original grid page, selection and URL unchanged.
Only the current resized derivative is loaded; originals (including HEIC/HEIF) are not requested.
Species Albums use the same slideshow controls within their currently displayed Album page.

Use **Retry image** or **Skip image** for unavailable media. Page failures offer **Retry page**
and, when a later page exists, **Skip page**. Recovery is explicit so disappearing Photos cannot
cause endless automatic requests. Pages already visited are a bounded session snapshot; concurrent
membership edits can shift positions. Close and reopen for a fully refreshed order and count.
No slideshow settings are persisted and no database changes are needed.

## Tag Explorer and exact tag filtering

Use **Tags** (`/tags`) for active-photo tag counts, alphabetical or most-used sorting,
search, distinct totals and a link to untagged photos. Trash is excluded; edits,
bulk tag operations, Trash and Restore are reflected by fresh aggregation requests.
The page reloads data when opened or the window regains focus. No new tables,
indexes, migrations, external services or image-file modifications are involved.

List **Exact tags** supports one or up to 20 tags with AND semantics. `bird` does
not match `birds`, and `Birds` remains distinct from `birds`. The shared existing
normalizer trims Python whitespace and removes duplicates while preserving case.
General text Search remains a separate broader filter; all existing List criteria,
sorting, pagination and global facets continue to work in combination. Individual
chips and Clear tag filters remove criteria. Photos without tags clears selected
tags and is mutually exclusive with them. Browser history and copied URLs preserve
filters: `/?catalog_tag=birds&catalog_tag=sunset` or `/?catalog_untagged=1`.

`GET /catalog/tags` returns `{ "tags": [{ "name": "birds", "count": 12 }],
"total_tags": 1, "untagged_count": 3 }`. Counts are distinct active photos per tag,
including only non-empty string entries in JSON arrays. Aggregation uses SQLite
`json_each` with guarded JSON validation in two SQL statements and hydrates no
Photo objects. SQL trims the same whitespace set as the shared Python normalizer.
Duplicate legacy array entries count once per photo. Invalid JSON, JSON null,
non-array values, non-string entries, and empty strings are ignored for tagging;
arrays with no valid strings are untagged. Photo reads safely normalize these
legacy values without rewriting stored data.

`GET /catalog/photos` and `GET /catalog/culling` accept repeated `tags=birds&tags=sunset`
or `untagged=true`. Exact membership uses correlated JSON EXISTS, never textual
LIKE. The request limit is 20 tag expressions, at most 1000 characters per tag;
conflicting or excessive criteria return HTTP 422. Existing stored tags are not
length-limited or rewritten, so an unusually long legacy tag can appear in Explorer
but cannot be used as a live filter. JSON membership is a scan without a new
materialized index; cost grows with active photos, tag entries and selected tags.
The aggregation response contains one row per distinct tag, with local UI search
and sorting rather than server pagination.

Culling retains tag criteria. Map rejects exact tags/untagged with HTTP 422 and
provides an explicit UI explanation with a filtered-List link. Archive navigation
warns before opening another view without exact filters. Version-1 Smart Collections
reject dedicated tags at the API schema boundary; the UI blocks create/update and
explains how to clear tag filters. Dedicated tags are currently **live catalog
filters**, not persisted Smart Collection criteria. Query version 1 and the separate
`feature/smart-collections-v2` work remain independent.

Bulk add/remove retains the 250-photo cap, explicit submission, validation,
transactional changes, review/audit behavior and active-photo restrictions. Suggestions
only fill the existing comma-delimited input; tags containing commas are omitted
from suggestions because that input cannot represent them as one tag.

Tag-query measurement on 2026-10-28 used the existing deterministic disposable
archive benchmark generator, one warm-up and five measured runs (Windows, local
SQLite; medians, concurrent validation active). These are local observations,
not latency guarantees:

| Photos (active) | Tag aggregation | One tag, page 1 | Two AND tags, page 1 | Untagged | Ordinary browse |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 (9,500) | 74.91 ms | 42.18 ms | 72.82 ms | 30.61 ms | 3.20 ms |
| 100,000 (95,000) | 925.57 ms | 492.70 ms | 549.91 ms | 356.30 ms | 21.21 ms |

The dataset has six distinct tags and 1–4 entries per photo, with no untagged
photos. Catalog measurements include counts, a maximum 48-photo page and global
facets. Untagged therefore measures a zero-result count plus facets. Aggregation
always runs two statements; existing browse query shapes remain unchanged.

## Archive-wide tag management

In Tags, choose Rename, Merge or Delete beside a tag. Operations affect every
matching Photo, **including Trash**. Explorer usage counts still show active Photos.
Names are case-sensitive and whitespace-trimmed: `Birds` → `birds` is an explicit
merge, not a global change to case rules. Rename to an existing destination also
merges. Merge requires an existing destination, including tags used only in Trash.
Delete removes the exact tag without deleting Photos and requires explicit confirmation.
Existing destination positions are retained; otherwise the replacement occupies
the first source position. Unrelated values and their order remain unchanged.

The read-only `POST /tags/operations/preview` accepts
`{"operation":"rename","source":"bird","destination":"birds"}` (omit destination
for delete). It returns `active_photos`, `trashed_photos`, `destination_overlap`
(affected Photos already containing the destination), `total_photos`,
`destination_exists`, up to five before/after examples and `preview_token`.
`POST /tags/operations/apply` accepts the same operation plus `preview_token`;
delete also requires `"confirm_delete":true`. Unknown fields, client counts and
Photo IDs are rejected. Tag names are limited to 1000 characters and exclude
embedded ASCII control characters. Responses use structured `detail.code` and
`detail.message` errors: `invalid_tag_operation`, `source_not_found`,
`destination_not_found`, `delete_confirmation_required`, `invalid_preview`,
`stale_preview`, `archive_busy`, `tag_preview_failed`, and `tag_operation_failed`.

Preview uses an explicit read transaction. Apply obtains `BEGIN IMMEDIATE`,
recomputes the snapshot fingerprint and validates the signed operation before
writing. A changed source/destination Photo, membership, Trash state or timestamp
invalidates the preview. Duplicate/concurrent submissions cannot apply the same
snapshot twice; the second receives a conflict. Failure rolls back every batch.
No client counts or IDs determine the update. Tokens expire after 15 minutes and
are bound to the current backend process; restart/reload requires a new preview.
This follows the supported local single-process API deployment; multiple workers
do not share preview signing keys. Busy writers may return HTTP 409; retry preview.

Guarded SQLite JSON membership queries ignore invalid/non-array legacy JSON.
Mixed arrays preserve unrelated non-string entries, blank strings and duplicates;
only source/destination occurrences change. Matching rows stream for fingerprinting;
updates use keyset pages and SQL batches of 250 within one transaction, without
hydrating the archive. Work still scans tag JSON and holds a write reservation
through revalidation and all updates, so large operations can delay other writers.
No new tables, migrations, dependencies, external requests or AI processing are used.

Only actual tag changes update `Photo.updated_at`. Classification status,
`reviewed_at`, animal/taxonomy associations, Collections, Events, favorites, ratings,
culling state, GPS/capture data and image references remain intact. No original
image bytes are read or modified by these operations. Filters, Search, Culling,
bulk suggestions and Trash/Restore use the corrected values. Existing Smart
Collections remain compatible with their existing query version.

## Metadata Health and cleanup

Open **Metadata Health** (`/metadata-health`) from archive navigation to see total
active Photos, missing capture dates, missing valid GPS, missing both, missing
either, complete Photos, and overall completeness. Click a count to open the
existing List, or use its **Metadata completeness** filter. The List URL preserves
this criterion with other filters, sorting and pagination across reload and browser
Back/Forward. Changing the criterion resets the page.

Completeness uses only effective Photo metadata: `captured_at IS NOT NULL` and
both latitude in [-90, 90] and longitude in [-180, 180], including valid `(0,0)`.
Partial or invalid legacy coordinate pairs are missing GPS. A complete Photo has
both groups; camera/lens EXIF, tags, taxonomy and classification do not contribute.
Import Session times, creation times and file modification times are never capture
date substitutes: importing does not establish when a Photo was taken. Trash is
excluded because it is outside the active archive; Restore makes a Photo count again.
An empty archive reports zero counts and 0% completeness.

From a filtered List, open a Photo, choose **Edit metadata**, enter the capture
date/time or GPS pair (optionally **Choose on map**), and Save. Use **Back to
catalog** to return to the same filtered List; a corrected Photo disappears when
it no longer matches. For bulk work choose **Select photos → Edit capture / GPS**,
select **Set GPS** or a capture date operation, preview, review and confirm.
Never assume selected Photos share a capture date; explicitly verify before
confirming a shared date. These actions preserve existing validation, optimistic
concurrency and classification/review state, and never modify original images.

For deliberately cleared or overridden metadata, **Restore original metadata** in
the editor may recover extracted values. It verifies and re-reads the original
file, rather than trusting a stale extracted snapshot. It replaces both manual
capture/GPS overrides in the individual editor; bulk Restore original lets you
choose the group and preview. Review before saving: restoration is always explicit
and never overwrites a correction automatically. Missing or changed originals may
prevent restoration. No speculative repairable count is shown.

The read-only `GET /catalog/metadata-health` endpoint returns `active_total`,
`missing_capture`, `missing_gps`, `missing_both`, `missing_either`, `complete`, and
`completeness_percentage` (rounded to two decimals). It performs one SQLite scalar
aggregate without Photo hydration, image decoding or network requests. Counts
reconcile with `GET /catalog/photos?metadata_issue=...`, where accepted values are
`missing_capture`, `missing_gps`, `missing_both`, `missing_either`, and `complete`.
The criterion combines with other live filters using AND semantics; invalid values
return 422. Culling also retains the criterion. No tables or migrations are added.

Metadata completeness remains a live List/Culling criterion. Version-1 Smart
Collection queries cannot save it, and Map does not support it. Navigation explains
these limitations and offers the filtered List or an explicit unfiltered destination;
clear the criterion before saving a Smart Collection. Direct Map API requests with
this criterion return 422. Wildlife Insights links undated Photos only for All Time;
missing-GPS links retain a selected capture year's date range. Existing Insights
percentages and comparisons keep their original meanings.
