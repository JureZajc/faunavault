# Nearby Photos implementation and validation

Branch: `feature/nearby-photos`. No release/version change, commit, push or PR.

## Behavior and API

Geotagged Photo details show Nearby Photos below Location map, with a native
1/5/10/25 km radius selector (default 5), nearest thumbnail links, rounded distance
labels and optional capture dates. Loading, empty, unavailable, error and Retry
states are supported. Radius changes preserve the detail view and current
`returnTo`, update `nearby_radius` without a reload, abort prior requests and
ignore stale success/error responses, including rapid switches back to a prior
radius. Thumbnail links use one local source return hop, retaining its radius
without nesting its earlier return context.

`GET /photos/{photo_id}/nearby?radius_km=5&limit=12` accepts only 1/5/10/25 km
and limits 1–24. The typed response contains `source_photo_id`, `radius_km`,
`availability`, `unavailable_reason`, `total` and `items`. Total counts every
matching Photo; items contain at most the requested limit. Preview fields are
`id`, `thumbnail_filename`, `original_filename`, `display_title`, `captured_at`
and `distance_m`. Missing/trashed sources return 404. Invalid query arguments
return 422. Sources with missing or invalid effective GPS return a 200 explicit
unavailable state with no items. No extracted GPS fallback is used.

## Distance and performance

Haversine uses a mean Earth radius of 6,371,008.8 m, wrapped longitude differences,
roundoff clamping and exact-pole cosine handling. Boundary inclusion allows a
0.000001 m floating-point tolerance. Sorting uses distance ascending, camera-local
capture timestamp descending with nulls last, then Photo ID ascending.

Two scalar-column SQL projections retrieve source coordinates and candidates.
Candidates use the shared catalog GPS/bounding-box predicate; antimeridian
crossings use longitude OR, and pole-touching regions cover all longitudes.
Active state, valid effective coordinates and exclusion of the source are applied
in SQLite. Candidates stream in batches of 256; a bounded heap selects the nearest
results while counting all circle matches. No Photo ORM objects, file reads,
N+1 queries, GIS extension, dependencies, new tables or migrations are introduced.

## Changed files

| Files | Purpose |
| --- | --- |
| `backend/app/routers/nearby_photos.py`, `backend/app/main.py` | Route and registration |
| `backend/app/schemas.py` | Typed response/previews |
| `backend/app/services/geography.py`, `backend/app/services/catalog.py` | Shared bounds predicate, radius bounds and great-circle distance |
| `backend/app/services/nearby_photos.py` | Lightweight batched selection and source validation |
| `backend/tests/test_nearby_photos.py` | API, independent reference distances, lifecycle and query/memory strategy coverage |
| `frontend/app/components/photo-detail/nearby-photos-section.tsx`, `photo-sidebar.tsx` | Nearby cards, radius control and async UI states |
| `frontend/app/lib/api.ts`, `frontend/app/lib/nearby-photos.ts` | Typed API client, GPS validation, radius parsing, distances and safe links |
| `frontend/app/photos/[id]/photo-detail.tsx` | Source-photo return label |
| `frontend/__tests__/nearby-photos.test.tsx`, `nearby-photos-api.test.ts`, `photo-detail.test.tsx` | Rendering, cancellation, formatting, keyboard and navigation tests |
| `frontend/e2e/nearby-photos.e2e.ts` | Disposable desktop/touch mobile journeys with locally fulfilled tiles |
| `README.md`, `frontend/README.md`, `docs/OPERATIONS.md`, `CHANGELOG.md`, this report | User/API/operations documentation and validation |

## Validation results

- Focused Nearby Photos desktop/touch mobile and existing Map Area journeys:
  **4 passed**. The new journeys verify 1 km and 10 km membership, exclusion
  outside 25 km, native keyboard selection/focus, thumbnail navigation and source
  return, Trash/Restore, effective GPS clearing and mobile overflow. Tiles are
  fulfilled locally. Desktop and 360 px touch-mobile screenshots were inspected.
- Full Playwright suite: **36 passed, 3 failed** out of 39. The failures are the
  same documented baseline: Trips & Events navigation expects 13 links but
  receives 14; Metadata Health desktop/mobile miss `No matching records` after
  GPS correction and return in full-suite order. Neither test was weakened.
- An initial focused rerun hit a transient browser load error on the existing
  Map forward-history step. Both Map journeys subsequently passed in the focused
  rerun and full suite. The new keyboard journey initially left Windows
  Chromium's native select popup open; it now closes the popup with Escape
  before asserting Tab navigation. Radius changes and assertions are preserved.
- `python scripts/dev.py check`: **passed, exit 0**. Ruff check/format passed;
  backend **1,042 passed, 9 skipped** (including all 35 new Nearby tests);
  frontend **436 passed in 43 files** (including 24 new tests across the nearby
  files and detail source-return test). TypeScript and production build passed.
  Lint has zero errors and one existing album-detail navigation warning. The
  backend has the existing FastAPI/Starlette HTTPX deprecation warning.
- `git diff --check`: **passed**. All source changes remain uncommitted.

Local command logs are retained in ignored
`frontend/test-results/nearby-validation/`. Desktop/mobile screenshots are in
their corresponding Nearby Playwright result directories. Production defaults
remain localhost-only; no release preparation or version bump was performed.

The initial focused baseline ran existing Trips & Events, Metadata Health
desktop/mobile and Map Area desktop/touch journeys: **4 passed, 1 failed**.
Trips & Events still expects 13 Archive views links but receives 14. Both Metadata
Health journeys passed in that focused order. The previous Map Area validation
report already reproduced their full-suite order-dependent failures on an
untouched starting snapshot; existing assertions are preserved.

Windows sandbox attempts failed on uv cache writes, pytest temporary paths and
Vite transform-cache renames. Validation therefore uses the permitted unsandboxed
executor and isolated loopback E2E ports 3109/8109 with disposable archives.

## Limits

- Distances approximate a sphere and inherit GPS accuracy; they are not travel
  distances or wildlife observations.
- Nearby circles and Map rectangles can include different Photos. Existing
  View on map, marker and clustering behavior is preserved.
- Changes in another tab require a new request or page refresh; no live push
  subscription is added. Trash/Restore, GPS corrections/clearing and permanent
  deletion affect subsequent requests.
- Dense geographic bounds can still require many distance calculations and
  SQLite may scan active rows; application memory remains bounded by the batch
  size and result limit.
- One-hop source returns intentionally omit the source's previous catalog/Map
  return context to keep URLs bounded.
