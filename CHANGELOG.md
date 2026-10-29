# Changelog

Release entries describe user-visible milestones rather than individual commits.

## [Unreleased]

### Added

- Nearby Photos below the Photo detail Location map, with 1/5/10/25 km circular
  searches (default 5 km), URL-preserved radius, cancellable requests, nearest
  thumbnail cards, distance/capture labels, local source return links and retry.
  Read-only `GET /photos/{photo_id}/nearby` uses effective GPS, SQLite geographic
  bounds and batched Haversine filtering with a bounded nearest-results heap.
  Supports zero coordinates, antimeridian crossings and poles; excludes Trash
  and invalid/missing GPS. Corrections and Restore affect subsequent requests.
  Circular results differ from rectangular Map selections; GPS accuracy limits
  distance accuracy. Includes backend, Vitest and disposable Playwright coverage.
  No new tables, migrations, dependencies or original-file changes.

- Photo Map geographic area selection by desktop drag, mobile two-corner taps,
  or accessible coordinate fields, with a visible rectangle, mapped Photo counts,
  replacement, clearing, and Map/List navigation. Inclusive validated bounding-box
  filters share catalog SQL, support antimeridian crossings and zero coordinates,
  persist in URLs/history/detail return links, and combine with existing List
  criteria. Missing GPS and Trash never match an area. No database migration,
  drawing dependency, image processing, or original Photo changes.

- Daily Photography Calendar integrated into Timeline with URL-restorable mode
  and year selection, all twelve Monday-first month grids, accessible daily
  photo intensity and List drill-down, yearly totals, active days, average Photos
  per active day, and linked most active day (earliest date breaks ties).
  Read-only `GET /catalog/calendar` uses camera-local effective capture dates,
  bounded SQLite aggregates and the existing capture index, without Photo
  hydration, images, dependencies or migrations. Undated Photos link to Metadata
  Health; corrections, Trash and Restore update counts on refresh. Includes
  boundary, cancellation, accessibility and disposable Playwright coverage.

- Metadata Health workspace (`/metadata-health`) with active Photo totals,
  missing capture/GPS groups, complete counts, and completeness percentage from a
  single SQLite aggregate. Effective capture timestamps and complete in-range GPS
  pairs (including `(0,0)`) define completeness; Trash and import timestamps do not
  contribute. Linked metrics and a URL-backed List filter reuse individual/bulk
  metadata editing and verified original restoration, with explicit Map and v1
  Smart Collection limitations. Wildlife Insights adds undated and missing-GPS
  drill-downs, retaining capture-year ranges for GPS. No migration or dependency.

- Wildlife Insights v2 adds scoped Top 10 cameras/lenses, identifiable/missing
  equipment coverage, and exact equipment/unknown drill-downs into List that
  retain the capture year. Optional explicit year comparisons restore through
  URL/history and show active Photos, distinct verified species, Favorites,
  Picks, Rejects, and GPS percentage-point differences, with zero-baseline guards
  and independent retry/cancellation. All shares use the period's active Photo
  total; missing EXIF stays unknown and Photo counts never imply observations.
  SQLite aggregates add two bounded queries; no migration or chart dependency.

- Camera & Lens Explorer at `/gear`, with active archive totals, exact partial-camera
  groups, lens usage percentages, search, alphabetical/most-used sorting and bounded
  SQL aggregation. Exact trimmed, case-sensitive manufacturer/model/lens and unknown
  equipment filters combine with existing List/Culling criteria, preserve URL/history,
  and support individual removal. Version-1 Smart Collection saves/updates and Map
  navigation explain unsupported equipment filters. Stored EXIF and originals remain
  unchanged; no equipment inference, external lookup, new tables or migrations.

- Archive-wide Tag Explorer Rename, Merge and Delete actions, including Trash,
  with read-only previews, affected counts, before/after examples, explicit delete
  confirmation and accessible responsive dialogs. Case-sensitive merging avoids
  duplicate destination tags. Signed previews, SQLite write locking, stale-preview
  rejection and atomic bounded updates preserve review state, unrelated metadata
  and original images. Successful changes refresh tag counts and suggestions.

- Tag Explorer at `/tags`, with active-photo counts, search, alphabetical/usage
  sorting, distinct and untagged totals. Exact case-sensitive List and Culling tag
  filters use AND semantics and support untagged photos, URL/history restoration,
  removable chips and existing bulk tag suggestions. Safe SQLite JSON aggregation
  handles malformed and duplicate legacy tags without new tables or migrations.
  Version-1 Smart Collection saves are blocked for live tag criteria; unsupported
  views explain their limitation and retain a link to the filtered List.

- Fullscreen galleries for manual Collections and Trips & Events, sharing the existing
  Species Album/Photo lightbox. Accessible navigation, captions/counts, image/page recovery,
  and opt-in 3/5/10-second slideshow with loading-aware timers, hidden-tab pausing,
  final-image stopping and reduced-motion transitions. On-demand 48-Photo pages use a
  three-page cache, abort obsolete requests and preserve the underlying grid. Event headers
  start at active custom covers using the existing ranked catalog API. No schema changes.

- Custom cover Photos for manual Collections, with responsive cards/headers,
  immediate accessible selection, clearing, and deterministic automatic fallback.
  Trash preserves the choice for Restore; membership removal clears it atomically
  and permanent deletion safely clears the reference. Append-only schema 21,
  backup-v1 verification/rehearsal for schemas 9–21, and deterministic metadata
  export v12 preserve covers, including trashed member references.

- Custom Trip/Event cover Photos with immediate member selection, removal,
  responsive thumbnail cards/headers, and deterministic automatic fallback.
  Trash retains the custom choice for Restore; membership removal and permanent
  deletion clear it. SQLite serializes cover/membership updates. Append-only
  schema 20, backup-v1 verification/rehearsal through schemas 9–20, and portable
  metadata v11 preserve covers, including Trash references.

- Interactive Leaflet GPS picker for single-photo metadata drafts and bulk Set GPS:
  click/tap, drag a marker, or edit full-precision coordinates. Accessible keyboard
  entry, Cancel/focus restoration, loading/error fallback, and responsive layouts.
  Existing Save concurrency and bulk preview/confirmation/atomic apply remain in
  place. Tiles use the existing external provider; no geolocation or geocoding.

- **Export selected** in the catalog selection toolbar: original-byte ZIP downloads
  for up to 250 explicit photo IDs, optional metadata JSON, size estimates,
  accessible confirmation and recoverable errors. Temporary archives are verified
  before download; unsafe, missing, changed, unsupported and trashed originals
  fail safely. Downloads use native browser handling without JavaScript ZIP Blobs.
  No schema migration, persistent jobs, or changes to archive export/backup formats.

- Create Trip/Event from Recent Imports or the contextual List Import Session
  card, using the existing Event form and APIs. Editable effective camera-local
  capture-date recommendations exclude Trash and show dated/undated counts;
  undated sessions require manual dates. Creation opens an import-scoped List
  with the new Event target, followed by explicit selection and confirmation
  for up to 250 photos. Canceling selection preserves the Event; successful
  creation retains continuation links. Grouped session statistics need no schema
  migration and never modify originals or automatically assign photos.

- Bulk **Edit capture / GPS** in List for up to 250 selected photos: shift
  camera-local times, set times with explicit offset handling, set/remove GPS,
  clear capture metadata, and independently restore original capture or GPS.
  Read-only per-photo previews require confirmation; apply is atomic and rejects
  stale versions, missing capture times, and unavailable or changed originals.
  Intentional clears retain provenance and prevent EXIF backfills from undoing them.

- Wildlife Insights at `/insights`: active-photo summaries, distinct verified
  species, yearly/monthly capture activity, top species, category/classification
  charts, and GPS coverage. URL-restorable year selection and List/Map drill-downs
  share existing capture and taxonomy semantics. Read-only SQLite aggregates
  exclude Trash and require no migration, chart dependency, or external service.
- Trips & Events with required dates, optional location/notes, explicit Photo
  membership, a paginated index with deterministic previews, and List/Map/Culling
  integration. Date suggestions use effective camera-local capture dates and
  require selection. Removal and Event deletion preserve Photos.
- List can add up to 250 selected Photos to an existing Trip/Event. Event scope
  survives navigation and Compare returns; Smart Collections remain query v1
  and exclude Event membership criteria.
- Import Sessions group successful Photos from one browser selection or offline
  folder invocation. Contextual Recent Imports shows historical outcomes and live
  active/Trash/Pick/Reject counts, with View imported photos and Cull this import
  actions using the existing List and Culling workspaces. File retries retain
  the original identity; unfinished operations show Not finalized.
- Session membership composes with List criteria, URL restoration, version-1
  Smart Collections, Compare, and scoped rejected cleanup. Folder labels retain
  only a bounded safe basename; no source paths or failed-file logs are stored.
- Rejected Photo Review and Cleanup through the existing filtered List, with
  contextual Review rejected entry from List/Culling, live counts, shared
  inspection/Compare, and explicit bounded selection for recoverable Trash.
  Restore returns Photos still marked Reject to review; Reject itself never
  deletes or moves a Photo.
- Cleanup confirms the selected count and atomically checks that every selected
  Photo is still active and Reject before moving any to Trash. Changed decisions
  stop the request; refresh and reselect explicitly. Curation, AI review metadata,
  and duplicate-review decisions retain their existing lifecycle semantics.
- Two-photo Compare Mode with URL-restorable pairs, entry from exactly two List
  selections, Duplicate Review candidates, and existing Culling neighbors.
  Independent zoom/pan and deliberate JPEG/PNG/WebP original inspection support
  larger viewing; narrow screens switch between Left and Right panes.
- Compare shares Pick / Reject / Clear, Favorite, and Rating controls with Photo
  detail, with targeted accessible controls, visible keyboard shortcuts, and
  refresh/conflict handling. Decisions never choose a winner, affect the other
  photo, resolve duplicates, or move a photo to Trash.
- Photo Culling workspace with independent Pick / Reject / undecided decisions,
  successful-save auto-advance, session Previous/Next history, visible keyboard
  shortcuts, and entry from the complete filtered List query.
- URL-restorable culling filters, shared Smart Collection criteria, explicit
  atomic bulk Pick / Reject / Clear actions, and detail/card/duplicate indicators.
  Picking does not Favorite or Rate; Rejecting does not move a Photo to Trash
  or accept AI classification.

### Reliability and data safety

- Schema 19 adds constrained Event metadata, non-reused IDs, and cascading
  membership keys. Trash retains membership; permanent Photo deletion removes
  joins while preserving empty Events. Metadata and membership changes never
  modify Photo, AI review, or duplicate state.
- Portable export v10 adds ordered Events/memberships and counts, including
  Trash, while retaining photos.csv. Backup v1 keeps its manifest shape and
  supports schemas 9–19, with structural verification, Event change signatures,
  exact recovery comparisons, and rehearsal totals.
- Schema 18 adds Import Sessions and nullable indexed Photo provenance. Existing
  Photos remain unassigned; Trash/restore retains membership and permanent
  deletion retains the session's original imported total. Folder dry runs stay
  read-only, and classification jobs do not control import completion.
- Portable export v10 includes ordered sessions, aggregate history, nullable
  Photo membership, and CSV provenance. Backup format v1 retains its manifest
  shape and supports schemas 9–19, validating relationships and detecting session
  changes during creation, with exact recovery comparisons.
- Schema 17 adds a constrained nullable Photo culling state; historical upgrades
  initialize it to undecided and Trash/restore preserve it.
- Portable metadata export includes machine-readable culling decisions in
  JSON/CSV. Backup format v1 verifies and rehearses schemas 9–19, including
  culling metadata and detection of changes during backup creation.

### Fixed

- Inclusive List capture-date filtering now includes the final microsecond of
  31 December 9999, keeping Calendar drill-down totals consistent at the maximum
  supported year.

- Windows development reloads no longer interrupt the launcher and stop both
  servers. Combined and standalone backend commands isolate reload signals and
  retain Ctrl+C cleanup of workers. Backend watching is limited to `backend/app`,
  so editing tests no longer restarts the server.

## [0.2.0] - 2026-09-30

### Added

- Duplicate Review Center with persistent Keep both / Not duplicates decisions,
  pairwise comparisons, recoverable Trash actions, and explicit guarded scans
  for existing archive photos. Unresolved pairs return on restore; dismissed
  pairs stay dismissed while their fingerprint evidence is unchanged.
- Editable camera-local capture date/time, optional UTC offset, and GPS, with
  retained extracted values and Restore original metadata. Timeline, Map, List,
  and Smart Collections use the effective corrected values.
- URL-restorable Map filters for category/Unknown, verified Taxon,
  classification status, and inclusive capture dates. Map → List and compatible
  List → Map navigation preserve criteria; unsupported text and Favorite/Rating
  filters are explained instead of silently dropped.
- Personal Favorites and optional 1–5-star Ratings, accessible detail controls,
  and compact comparison/card indicators. List supports Favorites,
  exact/minimum/Unrated filters and null-last rating sorting. Smart Collections
  share these criteria; explicit atomic bulk actions set/unset Favorite and
  set/clear Rating independently of AI Review.

### Reliability and data safety

- Ordered migrations through schema 16 preserve existing archives and initialize
  new curation fields safely. Manual capture/GPS corrections and intentional
  clears survive backfill and Trash/restore without modifying original bytes.
- Backup format v1 verification and isolated recovery rehearsal support schemas
  9–16, preserving duplicate-review decisions, retained extraction, manual
  overrides, Favorites, Ratings, and Smart Collection definitions.
- Portable JSON/CSV metadata export v7 includes effective/source capture and GPS
  values, override markers, Favorites, and Ratings. Duplicate workflow state
  remains deliberately excluded; verified backups preserve it for recovery.

## 0.1.0

First intentional public, source-based FaunaVault release.

### Added

- Local animal-photo archive with SQLite metadata and byte-preserved originals.
- JPEG, PNG, WebP, HEIC, and HEIF ingestion, local previews, capture/camera/GPS
  extraction, and safe recursive folder import with dry-run support.
- Paginated search/filter/sort catalog, capture Timeline, clustered Map,
  species Albums, manual Collections, and saved-query Smart Collections.
- Explicit catalog selection and atomic bulk tag, category, Collection, and
  recoverable Trash actions.
- SHA-256 exact duplicate protection and perceptual duplicate review.
- Optional local Ollama classification with durable jobs, provenance, retries,
  confidence-based Review Inbox, and manual metadata editing.
- Local taxonomy with GBIF lookup, recoverable Trash, and portable JSON/CSV
  metadata export.

### Reliability and data safety

- Ordered, backed-up SQLite migrations through schema 13.
- Cold verified backups, read-only archive doctor, trusted-original derivative
  repair, and isolated restore rehearsal for backup-v1 schemas 9–13.
- Journaled permanent deletion and explicit classification restart recovery.
- Fresh-run isolation and intermediate-schema recovery coverage, including
  structural verification of review and Smart Collection fields.

### Developer experience

- Portable default archive locations, localhost backend binding, frozen setup,
  actionable setup diagnostics, and shared application version reporting.
- Concise first-run README, detailed operations guide, and manual release runbook.
- Backend/frontend validation and real Chromium smoke coverage against disposable
  storage, without AI or external API requirements.
- MIT project license; the synthetic HEIC fixture retains its BSD-3-Clause notice.

### Known limitations

- Single user, single machine, one local backend process; no authentication,
  cloud sync, desktop installer, or automatic update.
- AI is optional and local. GBIF taxonomy and OpenStreetMap basemaps use the
  network; the basemap is not offline.
- Production restore is manual. Backups have no scheduling, retention,
  compression, encryption, or cloud destination management.
- HEIC/HEIF previews use the primary still image with 8-bit decoding; no HDR,
  gain-map, full color-fidelity, editing/re-encoding, or AVIF promise.
- Synthetic metadata benchmarks covered 1k–100k photos. Search remains linear;
  measured timings are machine-specific service results, not end-to-end or
  universal performance guarantees. See the [benchmark report](docs/CATALOG_BENCHMARK.md).
