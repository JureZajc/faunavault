# FaunaVault frontend

The Next.js 16 App Router frontend provides the photo catalog, capture-date
Timeline, clustered archive Map, species Albums, manual and Smart Collections,
metadata review, persistent local-AI job controls, and Trash workflows.
Start with the [root README](../README.md). Detailed storage, backup, and backend
behavior are in the [operations guide](../docs/OPERATIONS.md). The frontend is a
private package with no independent release version; the backend project
manifest owns the application version.

The frontend is localhost-only by default. Both `npm run dev` (with hot reload)
and `npm run start` (after `npm run build`) bind to `127.0.0.1`, on port 3000 by
default. Open `http://localhost:3000` or `http://127.0.0.1:3000` on this machine.
Port overrides still work, for example `npm run start -- --port 3001`; browser
smoke tests use frontend port 3001 and backend port 8001 on loopback.

FaunaVault has no authentication and is not intended for public internet exposure.
Access from another device requires explicit, deliberate changes to the server
bind addresses, `NEXT_PUBLIC_API_URL`, and backend CORS origins. Localhost binding
does not replace authentication or other protections for intentional network
deployment. See the [root startup instructions](../README.md#starting-faunavault).

## Camera & Lens Explorer

Open **Gear** (`/gear`) to explore active Photos by camera or lens. The overview
shows distinct nonblank models and missing-equipment totals. Percentages use all
active Photos, including those without EXIF. Search and alphabetical/most-used
sorting run on bounded server pages; Previous/Next reaches the rest of the archive.
Camera labels omit a repeated manufacturer, without merging stored identities.

Equipment links open the canonical List. Its **Exact equipment** controls select
manufacturer, camera model and lens independently, with AND semantics, unknown
options, removable criteria and Clear equipment filters. Search equipment options
and page through options for larger archives. General text search remains available.
Changing criteria resets pagination; URL parameters preserve choices through reload
and Back/Forward. An empty component means missing metadata, preserving exact
manufacturer-only/model-only links. Selected values remain visible across option pages.

Matching is case-sensitive equality after trimming whitespace, including Unicode
whitespace. No brand inference, spelling normalization, equipment database, EXIF
rewrite, network identification or classification occurs. A camera is unknown only
when both make and model are missing; a lens is unknown when its model is missing.
Equipment criteria work in List and Culling. Version-1 Smart Collection creation
and updates are blocked with an explanation; Map and other archive navigation
explain unsupported equipment criteria and offer the filtered List.

Coverage: `npm test -- __tests__/catalog-gear.test.tsx` and
`npm run test:e2e -- gear.e2e.ts` (disposable EXIF JPEGs, desktop/mobile,
keyboard navigation, exact results, history, Culling and unsupported Map URLs).

## Interactive GPS location picker

Open a Photo → **Edit metadata → Choose on map**. Click/tap to select a point,
drag the marker to adjust it, or edit latitude/longitude directly. Existing GPS
centers the map and supplies the marker; missing GPS opens a world view without
selecting a location. **Use this location** updates the form draft; **Save** persists
it. Picker Cancel/Escape discards its selection; editor Cancel discards the draft.

In List, select up to 250 photos → **Edit capture / GPS → Set GPS coordinates →
Choose on map**. Confirm the point, preview the changes, check confirmation, and
apply. Choosing another location invalidates the previous preview.

Both numeric fields remain usable when tiles or the map cannot load. Complete
finite pairs, including `0,0`, are required; latitude is −90…90 and longitude
−180…180. GPS changes never adjust dates or UTC offsets. The shared picker uses
client-only dynamic Leaflet loading, existing marker/tile/lifecycle helpers, and
the existing modal focus/scroll lock hook. Opening maps may contact the configured
external tile provider, currently OpenStreetMap. No device location, geocoding,
photo metadata, or filenames are sent to it; tile requests identify the viewport.

Coverage: `npm test -- __tests__/gps-location-picker.test.tsx
__tests__/photo-detail.test.tsx __tests__/bulk-capture-dialog.test.tsx` and
`npm run test:e2e -- gps-picker.e2e.ts bulk-capture.e2e.ts` (disposable archives,
desktop/mobile, local tile responses or simulated tile failure).

## Bulk capture and GPS editing

From List, select up to 250 photos and choose **Edit capture / GPS**. Configure
Shift capture time, Set capture date and time, Set/Remove GPS, Clear capture
metadata, or Restore original metadata (capture, GPS, or both). Review the
read-only before/after table and check the confirmation before applying.
The dialog uses the shared modal keyboard/focus utilities, supports narrow screens,
disables repeated submissions, and preserves selection on failure. Any failed apply
invalidates its preview; stale versions require a fresh preview and are never
retried automatically. A successful write uses the existing catalog refresh.

Times stay camera-local. Shifts preserve individual offsets and relative gaps;
missing capture timestamps block the whole selection. Set-time offers preserved,
specific signed `HH:MM`, or explicitly unknown offsets. Clears mark independent
capture/location overrides while retaining extracted provenance. Restore verifies
and re-reads original files; unavailable or changed originals block all changes.
Original bytes and AI decisions remain unchanged. Unlike individual editing,
every bulk change requires a preview and explicit confirmation. Existing Photo
fields continue to drive detail, List, Timeline, Map, Smart Collections, Trips &
Events suggestions, and Wildlife Insights.

Focused coverage: `npm test -- __tests__/bulk-capture-dialog.test.tsx
__tests__/catalog-bulk-actions.test.tsx` and
`npm run test:e2e -- bulk-capture.e2e.ts` (disposable storage, desktop and mobile).

## Architecture

`/insights` is a read-only Wildlife Insights dashboard backed by `GET /insights`.
Focused chart components use native CSS bars with semantic lists, visible counts,
and keyboard-accessible List links. The `year` URL parameter restores selection;
requests are aborted and stale results ignored when it changes. All Time shows
yearly capture counts, while a selected year shows twelve months including zeros.
Summary cards cover active photos, distinct linked species-rank Taxa, Favorites,
Pick/Reject, and GPS/capture-date coverage. Category and classification counts
share the selected period and denominator. Undated photos belong only to All Time;
AI guesses never enter verified species counts. Photos are images, not observations
or animal counts. Map links retain the capture-year filter.
The frontend fetches aggregates without loading the entire catalog and adds no
chart library. Top species are limited to ten; category charts show twenty named
categories plus Uncategorized and an exact Other remainder when necessary.
See [metric definitions and limitations](../docs/OPERATIONS.md#wildlife-insights).

`/imports` is contextual Recent Imports, linked from upload, List, and Culling.
The upload hook retains one UUID across sequential uploads, duplicate resolution,
and retries, with separate session lifecycle errors. Session cards fetch bounded
metadata and live counts; `catalog_import_session_id` restores membership through
the ordinary List/Culling and version-1 Smart Collection query paths. No new
permanent archive navigation item is added. See the
[Import Sessions guide](../docs/OPERATIONS.md#import-sessions-and-recent-imports-v03).

Both Recent Imports and the contextual List session card offer **Create Trip/Event**.
The existing Event dialog refreshes the session, defaults to Trip, suggests only a
safe label, and prepopulates effective camera-local capture-date recommendations.
Users review/accept or edit the range; completely undated imports require manual
dates. The extended session read model supplies `earliest_capture_date`,
`latest_capture_date`, `dated_count`, and `undated_count` through grouped SQL.
Trash is excluded. No timezone conversion or import-date fallback is used.
Creation navigates to List with `catalog_import_session_id` and `add_to_event`,
preserving valid List criteria and clearing obsolete Event scope and page.
Selection remains explicit across pages, with a separate confirmation and a
250-photo limit. Creation errors retain input; successful creation retains its ID
and continuation links so navigation failure does not trigger another creation.
Canceling selection leaves the Event intact. Membership success links to the Event.
The `import-event.e2e.ts` journey exercises desktop/mobile with disposable data.

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

The `/review` route uses the backend's filtered one-item inbox projection and
`?photo=<id>` for navigation and refresh. It reuses photo media, metadata editing,
linked-animal taxonomy, and classification job components. Accept and metadata
saves advance to the next item; missing or trashed items redirect to the first
remaining item. Arrow shortcuts apply only outside editable controls and the
lightbox. See the operations guide for review persistence and API semantics.

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
camera/lens/dimension fields remain read-only. Capture time, an optional signed
UTC offset, and atomic latitude/longitude can be edited in the existing form.
Date/time serialization preserves camera-local strings and full stored precision.
Clear actions retain authoritative manual markers; Restore is staged until Save
and replaces both supported groups from the original. Saves use the version
captured when the editor opens. Capture-only changes leave AI review pending.

The basemap uses standard remote OpenStreetMap raster tiles with visible
attribution. Photo metadata and preview images continue to come only from the
local FaunaVault API; the tile host receives ordinary visible-viewport tile
requests, not Photo records. There is no geocoding, map pin dragging, analytics,
offline tile downloader, or claim that the remote basemap works offline.

Durable classification state is restored from the backend after refresh. The
frontend polls only while queued or running work exists and keeps low-confidence
`needs_review` results distinct from failed job execution. Bounded internal
Ollama retries remain a backend detail: the durable job stays `running`, mixed
batch counts remain independent, and exhausted failures retain the existing
manual Retry action with a stable backend message.

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

Manual Collection cards and detail headers display a large thumbnail using the
same preview renderer as Trips & Events. **Set as cover** on an active member saves
immediately; **Current cover** identifies the custom choice. **Remove custom cover**
restores the newest active member (creation timestamp, then ID), with a placeholder
when none remain. Trash temporarily displays the automatic fallback and Restore
returns the custom cover while membership remains. Removing membership or permanently
deleting the Photo clears the choice. Cover saves preserve pagination and selection,
disable conflicting actions, and announce success or recoverable errors. The API
returns lightweight previews in summary/detail responses and accepts
`PATCH /collections/{id}/cover` with `{ "photo_id": number | null }`.

List offers **Save as Smart Collection** for its current search, filters, and
sort, including search text still awaiting debounce. The page and grouped
layout are not saved. `/collections` separates manual groups from live saved
queries, and `/collections/smart/<id>?page=N` restores a Smart Collection page.
Its **Edit criteria** action uses the existing List controls with an explicit
Save changes banner. Smart detail does not expose membership removal or bulk
selection; Add to Collection continues to list manual Collections only.

## Upload queue and duplicate review

The **Duplicates** navigation destination (`/duplicates`) reviews persisted
archive pairs. It reuses Photo media/lightbox and metadata presentation, provides
Keep both, Previous/Next/Skip, normal detail links with a return URL, and separately
labelled left/right recoverable Trash confirmations. Skip does not resolve a pair;
Trash resolution follows Photo lifecycle. The current canonical pair is encoded
as `left`/`right` URL parameters. The page shows scan coverage alongside its empty
state and performs no similarity calculations. Browser upload Keep both sends
displayed candidate IDs so those decisions do not immediately reappear here.

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

To run the selected-original export journeys (desktop/mobile native downloads,
ZIP/manifest/checksum validation, error recovery and preserved selection), use
`npm run test:e2e -- selected-export.e2e.ts`. When default ports are occupied,
choose free loopback ports without stopping unrelated servers:

```powershell
$env:FAUNAVAULT_E2E_FRONTEND_PORT = "3002"
$env:FAUNAVAULT_E2E_BACKEND_PORT = "8002"
npm run test:e2e -- selected-export.e2e.ts localhost.e2e.ts
```

All smoke tests use the configured backend URL. The E2E-only backend launcher
verifies disposable database/image paths and allows only the configured loopback
frontend origins for alternate ports. Production CORS defaults stay unchanged.

## Photo curation

Photo detail offers an accessible Favorite toggle, native five-star radio group,
and Clear rating. Saves retain confirmed values until the server responds;
errors leave those values intact and overlapping edits are disabled. Cards and
duplicate comparisons display compact indicators without curation controls.
List supports Favorites only and a single exact/minimum/Unrated rating dropdown,
plus rating sorting. URL state and Smart Collection criteria preserve them.
Bulk dialogs Favorite/Unfavorite or set/clear Rating on explicitly selected IDs.
Map blocks unsupported curation URLs and preserves criteria when returning to List.


## Trip/Event cover Photos

Event cards use wide thumbnail covers; the detail header adapts to desktop and
mobile widths. On `/events/{id}`, **Set as cover** immediately saves a member
Photo and announces success. **Current cover** identifies the saved choice;
**Remove custom cover** restores automatic selection. Cover actions are separate
from membership selection and disabled while saving; API failures show an alert
and refresh Event and member data without changing the current page.

The API supplies `cover_photo_id` and lightweight `cover_photo` metadata.
Automatic selection uses active membership ordered by `created_at DESC, id DESC`.
Trash hides the saved cover and shows a fallback; Restore reactivates it while
membership remains valid. Removing membership or permanently deleting the Photo
clears the saved cover. Empty Events have a placeholder. Existing thumbnail URLs
and components are reused; originals are never requested for covers.

Coverage: `npm test -- __tests__/events-ui.test.tsx __tests__/events-api.test.ts`
and `npm run test:e2e -- event-cover.e2e.ts` (disposable archive; desktop/mobile,
reload persistence, keyboard access, overflow, Trash/Restore and removal).

## Fullscreen gallery and slideshow

Manual Collection headers offer **Open gallery**, Trip/Event headers offer **View gallery**,
and member cards offer **View in gallery**. Header actions start at the first active Photo,
or the active custom Event cover. The shared ImageLightbox retains existing single-photo
and Species Album consumers; Album playback covers the currently loaded Album page.

Use Previous/Next or Left/Right arrows when the viewer has focus; Escape closes and restores
focus. Tab stays inside the viewer. Controls retain their native keyboard behavior. Play/Pause
is keyboard accessible, with selectable 3, 5 (default), and 10 second intervals. Playback is
always opt-in, waits for image loading, stops at the final image, pauses on errors or a hidden
tab, and does not resume when returning to the tab. Reduced motion disables image transitions.

The paginated adapter requests existing active-member APIs in their existing order, 48 Photos
per page, retaining at most three pages. It fetches no originals or adjacent images in advance,
uses resized derivatives, aborts obsolete requests, and leaves grid pagination/selection/URL
untouched. The existing ranked catalog endpoint locates distant Event covers in one request.
Retry image/page and Skip image/page controls recover from unavailable media or membership changes.
Cached pages are a session snapshot; close/reopen to fully refresh concurrent archive edits.

Coverage: `__tests__/gallery-slideshow.test.tsx`, existing Album modal tests, and disposable
browser journeys in `e2e/gallery.e2e.ts`. Run `npm run test:e2e -- gallery.e2e.ts` for focused journeys.

## Tag Explorer and tag filter state

`/tags` uses `GET /catalog/tags` to display active-photo usage counts, distinct tags,
and photos without tags, with search, alphabetical/usage sorting, loading, empty,
error and retry states. Links use the existing catalog URL writer through
`tagListHref`. List stores each exact tag as a repeated `catalog_tag` parameter;
`catalog_untagged=1` selects photos with no valid tags. For example,
`/?catalog_tag=birds&catalog_tag=sunset` requires both tags. Matches are case-sensitive
and whitespace-trimmed; `bird` does not match `birds`. General Search remains separate.

The List toolbar supports searchable options, selected chips, individual removal,
clear-all, and a mutually exclusive Photos without tags checkbox. Changes reset
pagination and preserve other criteria; browser Back/Forward restores them. At most
20 tag filters of 1000 characters each are accepted; excessive URL criteria show an
API validation error. Culling preserves exact filters. Unsupported archive views
explain the limitation before dropping filters, and a directly opened Map URL
with tag filters offers the corresponding filtered List.

Version-1 Smart Collections cannot persist dedicated tag/untagged criteria. Create
and update are blocked while these criteria are active, with a clear-filter
explanation, and `savedQueryFromState` guards the serialization boundary. Existing
bulk add/remove dialogs can suggest tags; selecting a suggestion only fills the
input and never submits. Comma-containing legacy tags remain selectable as exact
filters but are omitted from the comma-delimited bulk suggestions.

Focused coverage: `npm test -- __tests__/catalog-tags.test.tsx` and
`npm run test:e2e -- tags.e2e.ts`. The E2E runner owns a disposable database and images.

Tag cards also expose Rename, Merge and Delete without changing name-link navigation.
`tag-operation-dialog.tsx` uses the shared modal focus/keyboard utility and a
preview-then-confirm workflow. Operations cover the entire archive, including Trash;
active usage counts remain active-only. Destination input preserves case and is
trimmed on the server. Rename to an existing tag merges; Merge requires an existing
destination (a Trash-only tag can be typed). Delete has destructive styling and a
separate confirmation checkbox. All submissions disable controls, and changed,
expired or uncertain previews require Retry Preview before another apply.

`POST /tags/operations/preview` returns server counts, samples and a signed token;
`POST /tags/operations/apply` sends the operation, token and delete confirmation.
Successful operations announce results and emit `catalog-tags-changed` to refresh
mounted `useCatalogTags` consumers, including filter and bulk suggestions. Ordinary
navigation/focus refreshes data from the same catalog API. Exact filters, Search,
Culling and Restore read the updated metadata; Smart Collection query versions do
not change. Focus returns to the trigger, or the Explorer heading if it disappeared.

Coverage: `__tests__/tag-management.test.tsx`, `__tests__/catalog-tags.test.tsx`, and
`npm run test:e2e -- tag-management.e2e.ts tags.e2e.ts` with disposable archives.
