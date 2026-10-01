# FaunaVault v0.3 Trips & Events implementation report

Implemented in the existing checkout on 2026-10-01. This adds the final planned
v0.3 product feature; it does not publish a release.

1. **Domain model:** `ArchiveEvent` represents a Trip or Event with an integer ID,
   title, required start/end dates, optional location and plain-text notes, and
   creation/update timestamps. Both kinds permit one or several days. Titles
   normalize whitespace, allow duplicates, and are limited to 100 characters;
   location/notes are limited to 200/2,000. Blank optional text becomes null.

2. **Explicit membership:** the composite `(event_id, photo_id)` join permits a
   Photo in several experiences and Collections. Atomic requests accept 1–250
   distinct positive IDs. Missing Photos fail the entire operation; adding Trash
   conflicts. Repeated memberships are idempotent with separate counts. Event
   metadata and membership edits update only the Event timestamp. Editing Event
   dates or Photo capture metadata never changes membership, AI review, or
   duplicate decisions.

3. **Date suggestions:** Add suggested photos opens ordinary List with inclusive
   effective camera-local capture dates and an addition target. It excludes
   undated and trashed Photos and never substitutes creation/import dates.
   Copied URLs retain visible date criteria. Use current Trip/Event dates
   explicitly refreshes dates and clears selection while preserving search.
   Every addition requires explicit selection and submission.

4. **Schema/migration:** appended migration 19 creates Event and membership
   tables without changing historical migrations. Older archives start empty.
   SQLite AUTOINCREMENT prevents Event URL identity reuse. Composite keys,
   cascading foreign keys, metadata constraints and a reverse membership index
   follow the existing archive conventions. Interrupted migration retry is
   idempotent and preserves Photos.

5. **API:** typed GET/POST `/events`, GET/PATCH/DELETE `/events/{id}`, and
   POST/DELETE `/events/{id}/photos` implement index, metadata and membership
   operations. The index defaults to 24 and caps at 100, with optional kind.
   PATCH validates the merged date range. Runtime `event_id` extends catalog
   Photos, Map and Culling; malformed IDs fail validation and deleted Events
   return 404 without broadening the query.

6. **Index/detail:** `/events` restores All/Trips/Events and pagination in its URL,
   ordered by start date descending then ID descending. Cards show dates,
   location, active count and up to four deterministic previews. Detail shows
   metadata, plain notes and grouped active/Trash/undecided/Pick/Reject counts.
   Normal Photo cards paginate at 48, newest added first. Accessible dialogs
   retain API failures; removal/deletion focus Cancel and explain that Photos
   remain. Empty, all-in-Trash, unavailable and retry states are provided.

7. **List:** addition banners open List without a membership filter, accept
   bounded batches, clear successful selection and remain in List. A paginated
   target dialog also supports ordinary and Recent Imports-scoped selections.
   Invalid/deleted targets block adding. `catalog_event_id` survives filtering,
   selection, bulk operations and Photo detail. Membership/target changes reset
   selection; exactly two selected Photos can enter Compare and safely return
   to a numeric Event detail URL.

8. **Map:** Event membership composes with supported category, status, Taxon and
   date filters and Map → List navigation. Only active members with effective
   GPS become markers. Existing explanations for unsupported filters remain.

9. **Timeline:** View date range in List uses the existing Timeline date URL
   behavior. It clearly includes all matching archive Photos, even nonmembers.
   No Timeline overlay or inferred membership was added.

10. **Culling:** Cull this Trip/Event uses `source=list`, Event criteria and an
    Event-filtered List return URL. Anchors and previous/next candidates retain
    membership, including when a saved decision leaves the culling criterion.

11. **Collections/Smart Collections:** manual Collection membership is independent
    and unchanged. Persisted Smart Collection query version 1 remains unchanged;
    frontend saved-query types exclude Event scope, List explains why saving is
    disabled, and backend validation rejects `event_id` in saved definitions.

12. **Trash/Restore:** Trash preserves memberships while active views hide them.
    Restore makes them reappear. Permanent Photo deletion cascades join rows;
    the Event remains, including when empty. Removing membership or deleting an
    Event preserves Photos and other memberships.

13. **Backup/recovery:** backup v1 retains its manifest shape and supports schemas
    9–19. Schema-19 verification checks structure, keys, cascades, constraints,
    indexes, canonical metadata and references even for empty tables, before
    rehearsal writes. Event/membership signatures detect changes during backup
    creation and support exact recovery comparison. Old backups migrate to empty
    Event tables. Rehearsal output includes Event/membership totals.

14. **Export:** portable export v10 adds ID-ordered `archive_events`, ordered
    `archive_event_photos`, and both totals. It includes empty Events, Trash joins
    and every authoritative field, validates uniqueness/order/references, and
    produces byte-identical repeated exports. `photos.csv` remains unchanged;
    many-to-many membership is represented in authoritative JSON.

15. **Performance:** index counts and ranked previews are grouped and restricted
    to the requested Event page (four SQL queries, independent of card count).
    Detail curation counts use one aggregate. Membership uses a subquery rather
    than loading member sets. Catalog search/Taxon count paths preserve scope.
    Export shares Event validation without repeating the whole Photo inventory.
    No dependencies were added.

16. **Tests added:** 15 backend cases cover CRUD, canonical validation, atomicity,
    idempotence, Photo/AI/duplicate independence, combined catalog criteria,
    optimized counts, GPS Map, Culling neighbors, Smart rejection, grouped
    previews, lifecycle, deterministic export, backup signatures/exact recovery,
    migration retry and malformed empty-schema refusal before rehearsal writes.
    Frontend coverage adds forms, counts, retries, stale responses, restored URLs,
    target choice, safe removal/Compare, date refresh, scope/target selection
    resets, and HTTP JSON serialization. The disposable-storage Playwright
    journey creates a Trip, explicitly adds two Photos, reloads, opens Culling,
    removes one join and verifies the Photo remains active. It checks desktop
    and mobile navigation, alongside existing browser regressions.

17. **Validation results:** `python scripts/dev.py check` completed successfully:
    backend Ruff lint/format passed; **706 backend tests passed, 7 skipped**;
    frontend lint passed with no errors, type checking passed, **242 frontend
    tests passed**, and the production build passed. All seven skips concern
    symlink creation unavailable on this Windows environment. The existing
    Starlette/httpx deprecation and Albums navigation lint warning remain; Vite
    also reports its existing paths-plugin notice. `npm run test:e2e` completed
    successfully with **11 Chromium journeys passed**, using disposable storage
    and synthetic media without external services. Desktop/mobile Event
    screenshots were inspected. The final focused Event run passed all 15 cases,
    including oversized-ID validation and interrupted index creation. Focused
    schema/backup/export/recovery tests also passed in the full suite. Repeated
    v10 JSON and CSV exports are byte-identical, and `git diff --check` passed.

18. **Intentional limitations:** manual covers, recurrence, automatic membership,
    automatic GPS/event detection, Event coordinates, geocoding/place search,
    routes, GPX, travel bookings, weather, external calendars, shared accounts,
    cloud sync, facial grouping, AI-generated descriptions, geofences, nesting,
    itineraries and direct creation from Import Sessions remain deferred. Map
    retains its existing supported-filter contract. Production restore remains
    manual. No unrelated refactors or release publication were performed.

19. **Recommended next step:** acceptance passed; perform the v0.3
    release-readiness review, including final-commit CI and the existing release
    process. This implementation does not establish release readiness by itself.

README, Operations, metadata export format, improvement plan, release guidance
and the Unreleased changelog describe these contracts. Released v0.2 notes and
the frozen historical backup fixture are preserved.
