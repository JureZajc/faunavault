# Changelog

Release entries describe user-visible milestones rather than individual commits.

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
