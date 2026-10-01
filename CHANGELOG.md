# Changelog

Release entries describe user-visible milestones rather than individual commits.

## [Unreleased]

### Added

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

- Schema 18 adds Import Sessions and nullable indexed Photo provenance. Existing
  Photos remain unassigned; Trash/restore retains membership and permanent
  deletion retains the session's original imported total. Folder dry runs stay
  read-only, and classification jobs do not control import completion.
- Portable export v9 includes ordered sessions, aggregate history, nullable
  Photo membership, and CSV provenance. Backup format v1 retains its manifest
  shape and supports schemas 9–18, validating relationships and detecting session
  changes during creation, with exact recovery comparisons.
- Schema 17 adds a constrained nullable Photo culling state; historical upgrades
  initialize it to undecided and Trash/restore preserve it.
- Portable metadata export includes machine-readable culling decisions in
  JSON/CSV. Backup format v1 verifies and rehearses schemas 9–18, including
  culling metadata and detection of changes during backup creation.

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
