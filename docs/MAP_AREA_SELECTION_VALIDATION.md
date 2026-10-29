# Map area selection: implementation and validation

Validated on Windows on 2026-10-29, starting from clean commit
`b20cb4906638ac7d80cd315de79ab1bc2bdff79b`, on `feature/map-area-selection`.

## Implementation

- Desktop pointer drag, actual mobile touch corner selection, and labeled manual
  coordinate entry share the same validated bounds. A dashed orange Leaflet
  rectangle persists after confirmation; replacement, cancellation, Escape,
  clearing, loading, empty results, errors, and Retry use the existing Map page.
- `CatalogQuery` validates complete finite bounds and non-zero dimensions.
  Inclusive SQL predicates use effective Photo coordinates, exclude invalid GPS
  and Trash, and use an OR longitude predicate for antimeridian crossings.
  Catalog counts, ordering, pagination, Event intersections, and culling sources
  reuse the shared predicate. Broad text/Taxon count shortcuts retain bounds.
- `/catalog/map` keeps its scalar projection and deterministic Photo ID order.
  No Photo ORM hydration, image reads, new dependencies, tables, or migrations.
- `catalog_bbox_*` URL parameters restore through reload and history. Invalid
  bounds remain actionable errors. Map/List links, focused Photo `returnTo`,
  compatible criteria, and unsupported-filter explanations preserve the area.
  List supports independent area removal and intersections with its other filters.
- Selection event handlers and pointer capture are cleaned up before map teardown.
  Existing map/cluster ownership and stale-request cancellation are retained.
  Initial bounds fitting is synchronous so drawing cannot start on a moving map.
  Antimeridian markers and focused Photos use the same displayed world copy as
  their rectangle.
- Area filters remain live criteria; v1 Smart Collections cannot save them.

## Changed files

Backend:

- `backend/app/catalog_query.py`
- `backend/app/routers/catalog.py`
- `backend/app/services/catalog.py`
- `backend/tests/test_geographic_catalog.py`

Frontend query, navigation, and List:

- `frontend/app/lib/api.ts`
- `frontend/app/lib/catalog-query.ts`
- `frontend/app/lib/geographic-bounds.ts` (new)
- `frontend/app/lib/smart-collections.ts`
- `frontend/app/hooks/use-catalog-query-state.ts`
- `frontend/app/components/archive-navigation.tsx`
- `frontend/app/components/catalog/catalog-toolbar.tsx`
- `frontend/app/page.tsx`

Map and tests:

- `frontend/app/map/map-browser.tsx`
- `frontend/app/components/maps/archive-photo-map.client.tsx`
- `frontend/app/components/maps/leaflet-area-selection.ts` (new)
- `frontend/app/components/maps/map-area-controls.tsx` (new)
- `frontend/__tests__/archive-map-lifecycle.test.tsx`
- `frontend/__tests__/catalog-query-navigation.test.tsx`
- `frontend/__tests__/photo-map.test.tsx`
- `frontend/__tests__/geographic-bounds.test.ts` (new)
- `frontend/__tests__/leaflet-area-selection.test.ts` (new)
- `frontend/e2e/map-area.e2e.ts` (new)

Documentation: `README.md`, `frontend/README.md`, `docs/OPERATIONS.md`,
`CHANGELOG.md`, and this validation record. No versions were changed.

## Validation results

- Pre-feature focused Map smoke baseline: **2 passed**.
- `python scripts/dev.py check` ran the complete backend suite:
  **1,007 passed, 9 skipped**. Ruff check/format passed. During that invocation,
  temporary browser diagnostics caused three frontend mock failures; diagnostics
  were removed and all frontend steps were rerun on the final implementation.
- Final frontend lint: **0 errors**, one existing album-navigation warning.
  TypeScript and production build passed. Vitest: **412 passed in 41 files**.
- Geographic backend tests cover empty archives, boundary/zero coordinates,
  missing/corrupt GPS, invalid/partial/degenerate bounds, antimeridian areas,
  Trash/Restore, manual corrections, filter/Event intersections, pagination,
  counts, Map/List equivalence, query count, and absence of Photo ORM hydration.
- Focused desktop and actual touch-device Playwright area journeys: **2 passed**.
  Assertions cover visible rectangles, filtered counts, keyboard coordinates,
  List membership/additional status filtering, reload/history, focused detail
  return links, independent clearing, and responsive layout. Tile responses are
  fulfilled locally. Existing cluster/focus assertions were preserved.
- Full feature smoke suite: **34 passed, 3 failed**. An untouched `git archive`
  snapshot of the starting commit, using identical dependency versions and
  separate disposable storage/localhost ports, reproduced the same failures:
  **32 passed, 3 failed** out of its 35 existing journeys.
  - Trips & Events expects 13 archive links, while the baseline has 14.
  - Metadata Health desktop and mobile expect an empty result after correction
    in full-suite order. Both pass when run alone with the Trips & Events test.
  These existing failures were not changed or weakened.
- `git diff --check` passed. No commit, push, PR, release, or version bump.

Windows sandbox restrictions prevented Vite/uv temporary-file operations, so
browser tests and frontend validation used the permitted unsandboxed executor.
Occupied default E2E ports were avoided with isolated localhost test ports.

## Performance and limitations

On a disposable 100,000-record synthetic archive, seven warm service iterations
measured approximately **35 ms median** for selective empty normal/crossing areas
and **317 ms median** for the full-world area returning 33,287 points. Each Map
projection used one SQL query. `EXPLAIN QUERY PLAN` used `ix_photo_deleted_at`;
the schema has no GPS index. No migration was justified by these measurements.
These are local service measurements, not HTTP or browser rendering benchmarks.

Photos without complete valid effective GPS cannot match an area in Map or List.
External tile availability does not affect selection/filtering, but offline tiles
can leave the background blank. Large world selections retain the existing cost
of returning and clustering every matching point. Viewport/zoom is not persisted;
selected geographic bounds are. The three reproduced baseline E2E failures remain.
