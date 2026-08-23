# FaunaVault frontend

The Next.js 16 App Router frontend provides the photo catalog, capture-date
Timeline, clustered archive Map, species Albums, manually managed Collections,
metadata review, persistent local-AI job controls, and Trash workflows.
Project-wide setup, storage, backup, and backend behavior are documented in the
[root README](../README.md).

## Architecture

The catalog route in `app/page.tsx` remains the route-level orchestrator. Its
focused hooks own URL query state, paginated photo loading, lazy verified-taxon
options, classification-job polling, and upload state. Components under
`app/components/catalog/` own the toolbar, results, classification panel, upload
form, and per-file progress presentation. The List fetches one backend-filtered
page at a time, debounces search, and stores page, search, filters, sorting,
verified taxon, inclusive Taken-from/Taken-to dates, layout, and home view in the URL. Category grouping is
intentionally limited to the current page.

The photo-detail route follows the same boundary: `photo-detail.tsx` coordinates
loading, classification, return navigation, and Trash completion, while hooks
and components under `app/components/photo-detail/` own photo media, metadata
editing, linked-animal/taxonomy presentation, classification controls, the
sidebar, and the Move to Trash confirmation. State remains in focused React
hooks and route clients; the frontend does not use a global state or
data-fetching library.

The dedicated `/map` route loads one typed `GET /catalog/map` projection after
mount and renders loading, error, empty, and loaded states. Leaflet and
Leaflet.markercluster are imported only by dynamically loaded client modules
with SSR disabled; route and detail modules never evaluate browser-only map code
on the server. One shared imperative core owns tiles, custom asset-free markers,
responsive resize handling, and Strict Mode-safe cleanup. The archive runtime
adds chunked clustering and exact-coordinate spiderfying, while Photo detail uses
the same core for one non-clustered marker and coordinates already in its Photo
response.

The dedicated `/timeline` route follows the same focused client-data boundary:
an abortable hook loads one typed `GET /catalog/timeline` projection and the
route renders loading, error, empty, unknown-date, year, and month states. Month
links start from fresh URL parameters and open the existing List with
`catalog_taken_from`, `catalog_taken_to`, `catalog_sort=captured_at`, and
`catalog_order=desc`; they never inherit a previous List search or filter.
Timeline previews use existing thumbnail derivatives and remain non-interactive,
leaving detail navigation, pagination, search, selection, and actions to List.

Photo cards explicitly label their display date as `Taken` when capture metadata
exists and `Added` otherwise. Detail metadata formats capture timestamps as
camera-local wall time without passing them through JavaScript timezone
conversion, shows a recorded `UTC±HH:MM` offset or states that the timezone was
not recorded, and conditionally shows camera, lens, dimensions, and plain local
coordinates. Complete coordinates also render a compact detail map and a
`/map?photo=<id>` deep link. Photos without GPS omit the map cleanly. These
extracted fields are read-only and never enter PATCH bodies.

The basemap uses standard remote OpenStreetMap raster tiles with visible
attribution. Photo metadata and preview images continue to come only from the
local FaunaVault API; the tile host receives ordinary visible-viewport tile
requests, not Photo records. There is no geocoding, coordinate editing, analytics,
offline tile downloader, or claim that the remote basemap works offline.

Durable classification state is restored from the backend after refresh. The
frontend polls only while queued or running work exists and keeps low-confidence
`needs_review` results distinct from failed job execution.

Catalog Select mode follows the same route-local boundary. A focused selection
hook stores only explicit photo IDs, preserves them across pages and flat/grouped
layout changes, and clears them when the logical URL-backed query or collection
view changes. A separate mutation hook sends one typed bulk request, waits for
the authoritative result, clears selection only after mutation success, and
refreshes the catalog once. Selection is not written to the URL or browser
storage. Albums and Trash do not expose bulk selection; Collection detail has
its own route-local selection context used only to remove membership.

Native checkboxes and the existing accessible modal primitive support Add tags,
Remove tags, Set/Clear category, Add to Collection, and recoverable Move to Trash.
Collection create/rename share an accessible name dialog; deletion and membership
removal have explicit safety wording and Cancel-first focus. Select page is
strictly page-local, the client and server both enforce a 250-photo maximum, and
there is no all-matching-results or bulk permanent-delete action.

## Upload queue and duplicate review

The interactive uploader uses the single-photo API through a
frontend-controlled sequential queue; it does not send the selection through
the compatibility batch endpoint. Rows appear immediately as `Waiting`, then
truthfully transition through `Uploading`, `Uploaded`, `Exact duplicate`,
`Possible duplicate`, or `Failed` (`Cancelled` is the result of cancelling a
review). Progress is ordinal, not a fabricated byte percentage.

Each file keeps its own outcome, so a failure or duplicate does not stop later
files or undo completed uploads. Network and HTTP 5xx failures can be retried
individually while completed sibling rows remain unchanged. Catalog refreshes
are grouped after the initial pass and, when `Keep both` creates more photos,
after the review queue drains rather than after every file.

Exact byte duplicates retain their existing non-bypassable warning. Possible
visual duplicates open a keyboard-accessible review dialog with the local
upload and ID-based Catalog/Trash candidate previews. Each flagged item is
reviewed independently after the initial upload pass with `Keep both` or
`Cancel upload`; Keep both repeats that file's upload with explicit
authorization while the backend performs all checks again. A failed
confirmation leaves that review open, and remaining reviews and completed files
retain their state. Pending reviews live only in the current page and do not
survive refresh.

The picker accepts JPEG, PNG, WebP, HEIC, and HEIF. It does not decode or
convert files in the browser: the same `FormData` queue sends the selected
source to the local backend. HEIC/HEIF originals remain byte-identical in local
storage while the UI uses backend-generated JPEG resized images and thumbnails.
Container metadata is not guaranteed; capture time, camera/lens, dimensions,
and GPS appear only when the source exposes valid values.

## Modal and lightbox accessibility

Duplicate review, Move to Trash, permanent deletion, photo-detail deletion, and
the shared image lightbox use the same modal-accessibility hook. It supplies
modal semantics, safe initial focus, a focus trap that follows currently enabled
controls, Escape handling that respects busy submissions, focus restoration,
and reference-counted body scroll locking. The shared lightbox adds keyboard
previous/next navigation, loading and error states, and accessible labels.

## Development

Set `NEXT_PUBLIC_API_URL` in `.env.local`; see `.env.local.example` for the local
default.

```powershell
npm ci
npm run dev
```

As an optional repository-root shortcut, run `python scripts/dev.py frontend`.
On Windows, stop the Next.js development server before running `npm ci` because
loaded native modules under `node_modules` may be locked.

For routine repository-wide validation using the installed dependencies, run
`python scripts/dev.py check` from the repository root. For clean CI-equivalent
validation, stop the development server and run `python scripts/dev.py
check-clean`; it replaces `node_modules` with `npm ci` before validation.

Run a clean frontend validation sequence directly from this directory with the
development server stopped:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` runs the Vitest/JSDOM interaction suite.

## Browser smoke tests

The Playwright smoke suite complements Vitest rather than replacing it. Vitest
keeps API and navigation boundaries mocked for fast component-level interaction
coverage; the smoke command uses Chromium against the production `next build` /
`next start` output and a real FastAPI process with disposable SQLite and image
storage.

Install Chromium once, then run the suite:

```powershell
npx playwright install chromium
npm run test:e2e
```

The runner owns frontend port `3001`, backend port `8001`, both child processes,
and a uniquely named archive beneath the OS temporary directory. Occupied ports
fail the run instead of reusing an existing server. Temporary fixtures, the
database, and all generated images are removed after success or failure. The
smoke journey covers upload and duplicate safety, a real HEIC upload with a
JPEG thumbnail and extracted camera metadata, catalog/detail navigation and
metadata persistence, a GPS-backed archive marker/popup/detail-map path, real
backend image loading, Collection creation/add/delete without Photo loss, Trash
restore/permanent deletion, and one explicit two-photo bulk Move to Trash
contract. Tile requests are fulfilled inside Playwright, so the smoke has no
external map dependency. It makes no Ollama or GBIF request. Playwright traces and screenshots
are retained only for failures; they are ignored by Git.
