# Daily Photography Calendar implementation and validation

Branch: `feature/daily-photo-calendar`. Validation date: 29 October 2026.
Master baseline: `afcca89061e71dd2f37633b13f6570dffe8a1be7`.

## Behavior and API

Timeline remains the default view. Calendar is integrated at
`/timeline?view=calendar&year=2026` with URL/history restoration, retained year
selection across modes, twelve Monday-first months, camera-local date/count
labels, keyboard links, responsive layout, an explicit intensity legend and
summary. Most-active ties choose the earliest date. Active dates open the
existing paginated List with an exact inclusive capture-date range and capture
sorting. Undated Photos link to Metadata Health. Corrections, Trash and Restore
are reflected on refresh; original files are untouched.

`GET /catalog/calendar?year=2026` returns `year`, ascending `available_years`,
`photo_count`, `active_days`, `max_daily_count`, chronological
`days: [{date, photo_count}]`, and archive-wide `unknown_capture_count`.
Year is optional (defaults to the newest active capture year), validated from
1 through 9999, and null only for an unspecified year with no known capture dates.
Explicit empty years are retained.

Two scalar/grouped queries produce year options and undated totals. One grouped
query uses the existing `(deleted_at, captured_at, id)` covering index for the
selected year, with camera-local date substrings and no timezone conversion.
The response contains at most 366 daily totals, no Photos, paths or images.
Tests verify three queries, zero Photo ORM loads, and an SQLite EXPLAIN plan using
the existing capture index on a 1,000-Photo fixture. No migration, new dependency,
image processing, AI or external service was introduced.

Calendar tests also exposed an existing List upper-bound bug: the last
microsecond on 31 December 9999 was excluded. The shared List condition now
uses an inclusive maximum for that terminal date; ordinary dates keep their
exclusive next-midnight boundary.

## Changed files

| File | Change |
| --- | --- |
| `backend/app/routers/catalog.py` | Read-only Calendar route and year validation |
| `backend/app/schemas.py` | Typed daily counts and Calendar response |
| `backend/app/services/catalog.py` | SQL aggregates; maximum List date boundary fix |
| `backend/tests/test_photo_calendar.py` | API, lifecycle, boundaries, index and hydration coverage |
| `frontend/app/lib/api.ts` | Typed Calendar client and AbortSignal support |
| `frontend/app/lib/photo-calendar.ts` | Gregorian month generation, dates, List links, intensity, ties |
| `frontend/app/hooks/use-photo-calendar.ts` | Abortable year-keyed loading, stale response protection, Retry |
| `frontend/app/components/photography-calendar.tsx` | Reusable accessible twelve-month calendar |
| `frontend/app/timeline/calendar-browser.tsx` | Year selector, summary, URL defaults, missing dates and errors |
| `frontend/app/timeline/timeline-browser.tsx` | Segmented view control; existing Timeline content retained |
| `frontend/app/timeline/page.tsx` | Suspense boundary for Next search parameters |
| `frontend/__tests__/photo-calendar.test.tsx` | Focused Calendar component and request/history tests |
| `frontend/e2e/photo-calendar.e2e.ts` | Disposable end-to-end lifecycle, mobile and keyboard coverage |
| `README.md` | User-facing Calendar feature |
| `frontend/README.md` | Client behavior, data boundary and focused checks |
| `docs/OPERATIONS.md` | Date semantics, API, intensity, lifecycle and CI baseline |
| `CHANGELOG.md` | Unreleased feature and maximum-date fix |
| `docs/DAILY_PHOTO_CALENDAR_VALIDATION.md` | This implementation and validation record |

## Focused validation

- Final `python scripts/dev.py check`: **passed (exit 0)**. Ruff lint and format
  passed; backend **951 passed, 9 skipped**; frontend lint and TypeScript passed;
  frontend **393 tests passed across 39 files**; production Next build passed.
  Existing warnings remain: Starlette's httpx TestClient deprecation, one Albums
  navigation lint warning, and Vite's existing tsconfig-paths plugin notice.
- `git diff --check`: **passed**.
- Backend: `pytest tests/test_photo_calendar.py tests/test_catalog.py -q`:
  **77 passed**. Calendar contributes 18 tests, exercising empty and undated-only
  archives, single and repeated dates, year/month/midnight boundaries, leap and
  non-leap centuries, years 1/4/99/9999, opposite offsets, manual corrections,
  Trash/Restore, invalid years, sorted year options, Catalog count reconciliation,
  query count, covering-index usage and absence of Photo hydration.
- Frontend: `vitest run __tests__/photo-calendar.test.tsx __tests__/photo-timeline.test.tsx`:
  **14 passed**, including all unchanged Timeline tests. Covers Gregorian
  alignment, all twelve months, intensity and sparse years, tie-breaking, exact
  List URLs, accessible labels/focus, view-only loading, URL/default restoration,
  Back/Forward, retained years, empty years/archives, errors/Retry, rapid changes,
  cancellation and late success/error responses.
- Playwright: `npm run test:e2e -- photo-calendar.e2e.ts faunavault-smoke.e2e.ts metadata-health.e2e.ts`:
  **11 passed, 3 failed** (59.5 seconds). The new Calendar scenario passed.
  All three failing tests reproduce existing master failures described below.
  The existing Timeline smoke coverage passed. Desktop and 360px mobile Calendar
  screenshots were visually reviewed; mobile overflow and keyboard Enter
  drill-down assertions passed. Storage and uploaded Photos were disposable.

Windows runs used writable temporary storage and independent localhost ports
18281/18282 because the default backend port 8001 was already occupied. A first
attempt at default ports failed to bind; no existing service was stopped.
Restricted sandbox runs also encountered temporary-file permissions and Python
asyncio socket-pair restrictions; backend/browser validation was rerun with
working local process/socket access.

## Existing CI baseline

[Master CI run 40846278837](https://github.com/JureZajc/faunavault/actions/runs/40846278837)
was inspected before attributing failures to this feature. Backend, frontend and
Windows/Linux/macOS HEIC jobs passed. Smoke had 31 passes and these three failures:

1. Trips & Events navigation assertion at `faunavault-smoke.e2e.ts:48` expects
   13 archive links but receives 14 after Metadata Health was added.
2. Metadata Health desktop at `metadata-health.e2e.ts:43` expects an empty filtered
   List after correcting GPS. Requests omit the intended debounced search scope,
   allowing other missing-GPS fixtures to remain visible.
3. Metadata Health mobile fails at the same assertion and request pattern.

The final local related run reproduced the same three assertions. An earlier
Windows attempt additionally stalled the existing mobile Metadata Health page
at its loading state; the final run reached the same line-43 failure as CI.
Existing tests/assertions and CI workflow were preserved. Reproduction commands
and the likely search timing cause are documented in Operations.

## Limits

- The calendar refreshes on load, year selection or reload; it does not push
  updates from edits in another tab.
- Intensity bands are relative to the selected year with sparse-year minimums;
  colors are not intended for comparisons between years.
- Missing dates remain unknown until explicitly corrected. No dates are inferred.
- Browser coverage ran on Chromium under Windows; no new cross-platform matrix
  or large-archive timing benchmark was run. Index/aggregation behavior is covered
  directly, and no platform-specific runtime logic was added.
- No commit, push, pull request, release preparation or version bump was made.
