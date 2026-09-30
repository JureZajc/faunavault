# Duplicate Review Center — v0.2 implementation

1. **Architecture:** a persisted canonical pair queue with explicit Keep both
   decisions, queried through bounded FastAPI review endpoints. Photo lifecycle
   determines whether a pair currently needs review.
2. **Detection reuse:** existing SHA-256 original-byte protection and
   `phash64-v1` hashing remain unchanged. The importer index now exposes an
   all-match iterator; both discovery and ingestion use the same distance ≤4
   rule, normalization, original decoding and HEIC/HEIF behavior.
3. **Pair semantics:** each record has `left_photo_id < right_photo_id` and a
   composite key including detector version. Similarity chains never imply
   transitive equality. Equal SHA originals are integrity anomalies rather than
   normal visual-review candidates.
4. **Discovery:** stopped-archive `faunavault-maintenance duplicates-scan`, dry
   run by default, `--apply` to persist, deterministic ascending Photo IDs,
   500-pair upserts, interruption-safe reruns, external-commit detection, progress
   and explicit probe/pair limits. It compares stored hashes without decoding
   or changing originals and includes Trash for predictable restoration.
5. **Review state:** fingerprint snapshots, detector `phash64-v1:d4`, distance,
   discovery timestamp and nullable dismissal timestamp. Unchanged evidence
   preserves decisions; changed evidence reopens a rediscovered pair. No Photo
   metadata or AI-review state stores duplicate decisions.
6. **Schema:** migration 14 adds `duplicate_pair` and `duplicate_scan_state`,
   queue/reverse-reference indexes and cascading Photo foreign keys. Migrations
   1–13 and the frozen schema-9 backup fixture are preserved.
7. **API:** `/duplicates/summary`, `/duplicates/review?left=…&right=…`, and
   `/duplicates/pairs/{left}/{right}/dismiss`. Review uses deterministic
   previous/next pair navigation rather than returning a graph. Dismissal checks
   detector/discovery evidence and is idempotent. Existing lifecycle endpoints
   remain authoritative.
8. **Frontend:** `/duplicates` and shared navigation; labelled comparisons using
   existing media/lightbox and metadata components; filenames, capture time,
   dimensions, filesize, camera and category/species; Keep both, Skip,
   Previous/Next, detail links with return URLs and side-specific Trash dialogs.
   URL state, loading/errors, stale-pair notices, coverage and narrow layouts are
   supported. Mutations and dialog navigation have submission guards.
9. **Trash/restore:** Trash removes every affected pair from active eligibility.
   Restore reopens unresolved pairs but preserves explicit dismissal. Permanent
   deletion cascades pair removal through the normal purge lifecycle.
10. **Ingestion:** already detected matches persist in the same upload/import
    transaction. Browser Keep both sends bounded displayed candidate IDs and
    records those decisions atomically. Bare overrides and importer overrides
    leave pairs unresolved. Default importer skips, exact gates, staging
    compensation and source safety remain unchanged.
11. **Recovery:** backup format v1 supports schema 14 in addition to 9–13.
    Verification validates pair/scan structure and evidence; rehearsal compares
    deterministic streamed signatures so curation data cannot disappear
    silently. Cold backup detects review changes during copying/publication.
    Portable metadata export remains v5 and explicitly excludes duplicate state.
12. **Performance:** index memory is proportional to Photo count, plus bounded
    candidate buffers. Candidate work depends on bucket occupancy and output;
    dense fingerprints retain quadratic worst cases, bounded per attempt by
    50 million probes and one million pairs. Normal pages/startup/unrelated
    navigation do not discover pairs. An isolated 100k uniform-fingerprint
    applied scan completed in **5.541 seconds including preflight**, with
    **3,662,501 probes** and zero matches. A 2k identical-fingerprint fixture
    stopped safely at a deliberately reduced **10,000-pair** limit in
    **0.194 seconds**, after 49,481 probes. These synthetic measurements do not
    guarantee real-photo collection latency.
13. **Tests:** canonical identity/constraints; threshold/non-transitive chains;
    deterministic bounded navigation; dismissal persistence/stale evidence;
    both Trash sides/restore/cascades; API errors; HEIC parity; ingestion
    rollback; importer/upload regressions; scan dry-run/idempotency/interruption,
    external changes/limits/sparse work/source preservation; fresh schema and
    retained historical backup/rehearsal; curation preservation and cold-backup
    consistency. Frontend tests cover metadata/URLs, navigation/Skip, completion
    and coverage, both confirmations, cancellation/errors and submission guards.
    Smoke adds real byte-different fixtures, dismissal/reload and desktop/mobile
    screenshots in the existing isolated local harness.
14. **Validation:** `python scripts/dev.py check` passed: **451 backend tests
    passed, 6 skipped**, **124 frontend tests passed**, backend lint/format,
    frontend lint/type checking and production build succeeded. One existing
    album-detail navigation lint warning remains. `npm run test:e2e` passed
    **all 4 Chromium smoke journeys**, including real uploads, Keep both and
    persistent dismissal after reload. The browser test caught and verified
    correction of a missing JSON content-type header on dismissal. Desktop
    (1280px) and mobile (360px) screenshots were visually inspected; images,
    actions and metadata render correctly, and the mobile overflow check passes.
    Synthetic measurements above were run separately from ordinary checks.
    `git diff --check` passed. Validation used isolated archives; the configured
    user archive has not been scanned or modified by these tests.
15. **Limitations:** full coverage needs an explicit scan; ingestion persists
    only its existing three-match warning results. Missing fingerprints are
    unassessed until the existing backfill runs and discovery is repeated. Dense
    scans may require deliberately raised limits; reruns start from the
    beginning. No automatic deletion, ranking AI, groups, extra similarity
    algorithm, background scanner, metadata merging, or cloud dependency.
16. **Next v0.2 feature:** bulk taxonomy review, extending archive curation beyond
    the existing bulk tags/category/Collections/Trash actions.
