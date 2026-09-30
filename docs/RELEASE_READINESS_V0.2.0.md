# FaunaVault v0.2.0 release readiness

Audit date: **2026-09-30**. Target: source release **0.2.0**.

The readiness implementation and local functional gates pass. **Publication is
blocked by current dependency security findings and requires green hosted CI on
the final merged commit.** No tag was created or pushed; no GitHub Release was
published. The source release is prepared for review, not approved for tagging.

## Scope and release identity

Work started on the clean `release/v0.2-readiness` branch at
`d67f8f7f679649cb19c934922868b84ed1a7dc5e`, matching local `master` and
`origin/master`. The implementation changes version metadata, release/operations
documentation, first-run coverage, and one upgrade failure/retry test. It adds no
product features, application refactors, migrations, indexes, dependencies, or
browser journeys.

| Contract | Before | After |
| --- | --- | --- |
| Authoritative application version, `backend/pyproject.toml` | `0.2.0.dev0` | `0.2.0` |
| Editable backend version in `backend/uv.lock` | `0.2.0.dev0` | `0.2.0` |
| Latest database schema | 16 | 16 |
| Backup format / supported schemas | v1 / 9–16 | v1 / 9–16 |
| Portable JSON/CSV export | v7 | v7 |
| Smart Collection query version | 1 | 1 |
| Public APIs and dependency versions | Existing contracts | Unchanged |

`app.version.application_version()` remains the shared reader. Health, OpenAPI,
backup manifests, and diagnostics continue reporting that value. The manifest
and installed-package fallback are tested; health/OpenAPI, doctor, and a newly
created backup were also checked as `0.2.0` in the isolated source rehearsal.
The frontend introduces no application version source. Offline lock refresh
changed only the editable backend version; frozen sync installed that version.

The published `v0.1.0` tag, its changelog entry, historical
[readiness report](RELEASE_READINESS.md), migrations, frozen fixtures, CI, and
reviewed synthetic benchmark reports remain unchanged.

## Verified v0.2 feature inventory

- **Duplicate Review Center:** canonical pair comparisons, persistent Keep both
  / Not duplicates decisions bound to unchanged fingerprint evidence, explicit
  guarded scans, and recoverable Trash actions. Restoring an unresolved pair
  brings it back; a valid dismissed pair stays dismissed. Ingestion confirmation
  rechecks evidence, and duplicate curation stays independent of AI Review.
- **Capture and location corrections:** camera-local date/time, optional UTC
  offset, and complete GPS pairs; retained extracted values, intentional clears,
  protected backfill, and Restore original metadata. Browsing projections use
  effective values while original file bytes remain intact.
- **Map and List:** URL-restorable category/Unknown, verified Taxon, status, and
  inclusive capture-date filters. Reload/history and compatible Map/List
  navigation retain criteria. Text search and Favorite/Rating criteria are
  unsupported on Map and receive an explicit explanation/removal path.
- **Personal curation:** Favorites, optional integer Ratings 1–5, exact/minimum/
  Unrated List filters, unrated-last sorting in either direction, Smart
  Collection criteria, and atomic bulk Favorite/Rating actions. Curation persists
  through reload, Trash/restore, backups, and export without changing AI status.

The [dated changelog](../CHANGELOG.md) separates these four feature groups from
migration, recovery, and export data-safety notes. README now identifies v0.2.0
and links to focused Map and curation instructions in Operations.

## Migration, recovery, and export compatibility

The full backend check includes fresh schema initialization, ordered migrations
through 16, historical schemas 9–16 verification/rehearsal, malformed structure
rejection, and feature preservation. No frozen fixture was regenerated.

The added failure/retry test copies historical fixture data into a schema-13
backup and a separate runtime. An injected migration-16 failure leaves the
ledger at 15, with no recorded 16. Original bytes and timestamps, the source
backup, and frozen fixture remain unchanged. The automatic pre-migration
database has the original schema-13 logical contents and passes SQLite integrity
checking. Retry applies only 16, is subsequently idempotent, and preserves
extracted capture values with safe Favorite=false/Rating=null and override
defaults. Comparing logical database contents accounts for SQLite backup header
changes without weakening content checks.

Existing schema 9–16 tests verify required structures even in empty backups and
preserve active/Trash state, Collections and memberships, Smart definitions,
classification state, duplicate decisions, capture/GPS overrides and clears,
Favorites, and Ratings. A separate cold CLI pass on the disposable fresh source
created and verified a backup-v1/schema-16 archive, checked application version
`0.2.0`, and rehearsed recovery into a new sibling target.

Export tests retain deterministic JSON/CSV order and bytes, effective/source
capture and GPS, override markers, curation, portable original-file paths, and
null encoding. Duplicate workflow state remains intentionally excluded from
portable export; verified backups preserve it. The export guide now includes
`is_favorite` and `rating` immediately after `photo_id` in the CSV column list.

## Fresh installation and diagnostics

A disposable source copy was built from tracked working files, with no local
`.env`, `.env.local`, dependencies, or archive data copied. It ran the documented
`python scripts/dev.py setup` successfully: frozen backend installation and
frontend `npm ci`. Missing storage was expected at the initial successful root
doctor check. Node was 24.12.0; backend Python was 3.12.10; root launcher Python
was 3.14.0.

The same uvicorn reload and Next development commands used by the documented
startup workflow ran against this copy. Existing services occupied normal ports,
so the rehearsal used backend 8020 and the supported frontend origin 3001, with
only an API URL environment override. Storage stayed at portable defaults.
Health/OpenAPI reported `0.2.0`, the migration ledger reached 1–16, and empty
List, Timeline, Map, Albums, Collections, Review, Duplicates, and Trash rendered
in headless Chromium without page errors. Empty manual and Smart Collection APIs
were both checked. This was an ad hoc source rehearsal; no new journey was added.

The expanded isolated first-run test additionally rejects external HTTP attempts,
checks all empty destination APIs, performs synthetic upload/restart, and verifies
preservation and schema/index initialization. It passed in the full check.

Plain root doctor passed in the main checkout and fresh copy. It remains fast,
does not scan images, and leaves Ollama optional/unprobed. With the disposable
backend stopped, `doctor --archive` passed: schema 16, zero photos/jobs/orphans,
zero findings, **HEALTHY**. No integrity scan was run against the personal archive.
Sandbox cache, child-process, and temporary-directory restrictions required
approved unsandboxed execution for setup/startup/maintenance/profiling; they were
environment restrictions, not application failures.

## Focused performance sanity

Existing deterministic dataset generation, safety checks, correctness oracle,
query capture/plan helpers, and timing helpers were reused. All data was
disposable and synthetic. Each measurement used two warmups and 20 samples,
Windows 11 AMD64, Python 3.12.10, SQLite 3.49.1. These are local service timings,
not HTTP/browser timings or CI performance gates. Some profiling overlapped
local development startup; p95 variability should not be interpreted as a new
baseline. No indexes or production queries were changed and no full benchmark
suite was rerun.

The existing curation profile passed independent total checks and identical
List/Smart responses at 10,000 and 100,000 Photos:

| Scenario | 10k List / Smart median ms | 100k List / Smart median ms |
| --- | --- | --- |
| Default | 3.00 / 3.10 | 19.63 / 19.98 |
| Favorites | 18.34 / 18.62 | 254.21 / 251.54 |
| Exactly 5 | 18.40 / 18.50 | 252.37 / 253.80 |
| At least 4 | 18.10 / 18.71 | 252.97 / 252.84 |
| Unrated | 18.51 / 18.54 | 251.78 / 255.43 |
| Rating descending | 7.01 / 7.28 | 59.51 / 59.21 |
| Rating ascending | 7.19 / 7.34 | 57.41 / 58.11 |

Curation retains SQL counts and bounded page hydration; existing filter plans
may scan active rows, while Rating sorting uses temporary ordering. Smart queries
add a saved-definition read and reuse the catalog service. These observations
are consistent with the retained [curation performance evidence](CATALOG_BENCHMARK.md).

Representative filtered Map responses at 100,000 Photos matched the independent
oracle's complete ordered GPS membership and every projected field:

| Filter | Points | Queries | Median / p95 ms |
| --- | --- | --- | --- |
| Mammal category | 15,096 | 1 | 214.60 / 220.49 |
| Taxon 1 | 6,655 | 1 | 78.51 / 159.91 |
| Capture dates in 2024 | 3,048 | 1 | 45.69 / 124.63 |
| Category/status/taxon/date combined | 399 | 1 | 29.13 / 30.28 |
| No matching category | 0 | 1 | 28.35 / 29.63 |

Map reads a lightweight projection without full Photo hydration or N+1 queries.
Category/empty plans use `ix_photo_deleted_at`; date/combined plans use
`ix_photo_catalog_active_captured`, with temporary ordering by Photo ID. Taxon
criteria join through existing Taxon primary-key and Animal taxon indexes.

Persisted duplicate retrieval used 10,000 canonical synthetic pairs in the same
100,000-Photo archive: 1,000 dismissed and exactly 9,000 unresolved. First and
middle selection returned the expected pair, previous/next/first identities, and
total, excluding dismissed pairs. First retrieval used 6 SELECTs and measured
11.94 / 12.72 ms median/p95; middle used 7 SELECTs and 11.77 / 12.49 ms. Pair
selection/navigation queries use LIMIT 1; only the selected two Photos are
hydrated. Plans use `ix_duplicate_pair_queue`, keyset predicates for navigation,
and Photo primary-key lookups. There is no scan/discovery or full queue hydration
during retrieval. Raw JSON, SQL plans, source copies, and startup logs remain
ignored rather than committed as release evidence.

## Privacy, security, accessibility, and documentation

Tracked-file inspection found no private keys, token signatures, personal user
paths, local environment files, personal archives, imported media, or accidental
new raw reports. The schema-9 database, supported-image/HEIC fixtures, product
screenshots, and two previously reviewed synthetic benchmark JSON reports are
intentional retained artifacts. The only user-path signature was the documented
synthetic Unix setup example. The MIT license and HEIC BSD-3-Clause notice are
retained. This is a focused repository hygiene review, not a penetration test.

The **live** npm audits on this date report **9 affected packages** overall
(3 moderate, 5 high, 1 critical), and **3** in the production tree (1 moderate,
1 high, 1 critical): `baseline-browser-mapping`, `sharp`, and `next`. All-package
findings additionally include `brace-expansion`, `browserslist`, `js-yaml`,
`undici`, `vitest`, and `@vitest/mocker`. These are package counts, not counts of
distinct advisories. The locked versions were deliberately preserved as required
by this release plan; no audit fix or dependency update was performed.

Next.js 16.3.0 falls in the affected range for a critical
[Windows-hosted server RCE advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36).
Its documented App Router/Windows conditions apply to this supported startup
configuration; the advisory specifies a fix in 16.3.3. npm recommends Next
16.3.8 across the current findings. Additional image/OG paths are not used by
FaunaVault, but that does not dismiss the Windows server finding. **Require a
separate reviewed dependency security remediation and renewed applicable gates
before publishing.** The August [dependency security review](DEPENDENCY_SECURITY_REVIEW.md)
records its historical zero-finding result; it does not establish current safety.
A sandboxed production-only audit initially returned zero; approved live network
audits reconciled the result and supply the counts above.

Existing frontend tests and the lifecycle Chromium journey verify accessible
Favorite/Rating labels, keyboard rating controls and clearing, persistence,
dialog handling, and navigation. They passed. No new automated accessibility
scanner or comprehensive assistive-technology audit was run; the release edits
introduce no UI changes.

Documentation now describes eight archive destinations, current Map capabilities
and unsupported List criteria, schema 16 in the backup table, current-schema
scan prerequisites, Favorite/Rating Smart criteria, and the missing CSV columns.
Detailed Map and curation instructions moved from README to Operations. The
[release runbook](RELEASE.md) is reusable and includes concrete v0.2.0 commands,
all validation gates, clean/current master, clean-clone rehearsal, recovery,
license/privacy review, final hosted CI, and manual publishing. Local Markdown
file links and anchors were checked (59 targets). Historical documents remain intact.

## Validation and CI

| Gate | Actual result |
| --- | --- |
| Focused first-run + new migration failure/retry | 4 passed |
| `python scripts/dev.py check` | Passed |
| Backend Ruff lint / formatting | Passed; 102 files already formatted |
| Backend full pytest | **620 passed, 7 skipped**, 1 warning; 281.19 seconds |
| Frontend lint | Passed; one existing album-navigation warning |
| Frontend typecheck | Passed |
| Frontend Vitest | **159 passed**, 20 files |
| Frontend production build | Passed |
| `npm run test:e2e` | **6 Chromium journeys passed**, 14.5 seconds |
| Normal frontend build after E2E | Passed; ordinary API configuration restored |
| Isolated source setup / initial doctor | Passed |
| Default storage / eight empty browser destinations | Passed |
| Cold doctor on disposable archive | HEALTHY; zero findings |
| Disposable backup create / verify / rehearse | VALID / VALID / PASSED; HEALTHY |
| Existing curation + focused Map/duplicate profiles | Correctness and query-shape checks passed |
| `uv lock --check --offline` / frozen installation | Passed; dependency versions unchanged |
| Frontend `npm ci` / `npm ls --depth=0` | Passed; security findings recorded separately |
| Local documentation links / retained historical artifacts | Passed |
| Final `git diff --check` | Passed |
| Hosted CI on final merged commit | Required; not yet available for these uncommitted edits |

The seven backend skips remain the existing platform-specific symlink
coverage. Existing warnings are the Starlette TestClient/httpx deprecation,
Next ESLint's internal `window.location.href` warning, and Vite's native tsconfig
paths advisory. Browser tooling also emits its existing FORCE_COLOR/NO_COLOR
warning; uv may fall back from hardlinks to copying. None caused a functional
validation failure. Dependency vulnerabilities are a separate publication blocker.

The unchanged CI workflow retains backend lint/format/tests, frontend lint/
typecheck/tests/build, the six-journey Chromium smoke job, and HEIC codec decode
jobs on Linux, Windows, and macOS. No large benchmark, external-service check,
timing gate, or release publishing workflow was added. Local Windows results
do not substitute for green hosted CI on the final merged release commit.

## Remaining gates and maintainer handoff

Resolve the dependency security blocker in reviewed follow-up work. Review and
merge the readiness implementation, require current/clean `master`, rerun the
runbook's gates for any changed code or dependencies, perform its clean-clone
rehearsal on that final commit, and require every hosted CI job green. Current
changes remain reviewable and uncommitted; no final release commit is claimed.

Only after those gates pass, the maintainer runs:

```sh
git tag -a v0.2.0 -m "FaunaVault v0.2.0"
git show --no-patch v0.2.0
git push origin v0.2.0
```

GitHub Release title: **FaunaVault v0.2.0**. Select the existing annotated tag,
use the prepared notes below, and publish manually with GitHub-generated source
downloads. No tag was created or pushed and no GitHub Release was published by
this implementation. The published v0.1.0 tag was not altered.

## Prepared GitHub release notes

FaunaVault v0.2.0 focuses on archive curation and better use of capture and
location metadata.

- Review possible duplicates already in your archive, retain Keep both decisions,
  run explicit local scans, and use recoverable Trash while comparing pairs.
- Correct capture date/time, UTC offset, and GPS while retaining extracted values.
  Clear metadata intentionally or Restore original metadata without changing
  original files.
- Restore Map filters from URLs and move between Map and List with compatible
  category, taxon, status, and capture-date criteria.
- Favorite Photos and assign optional 1–5-star Ratings. Filter and sort in List,
  save criteria in Smart Collections, and apply curation to explicitly selected
  Photos with atomic bulk actions.

Ordered migrations retain archives through schema 16. Verified backup-v1 recovery
supports schemas 9–16, including duplicate decisions, correction provenance, and
curation. Portable JSON/CSV export v7 retains effective/source metadata,
overrides, Favorites, and Ratings; duplicate workflow state stays in backups.

This is a source release. Core archive functions work without Ollama; AI remains
optional and local. Map text/Favorite/Rating filters, cloud sync, multi-user
access, packaged desktop installers, automatic updates, semantic search, and AI
photo ranking remain outside this release. See README and Operations for setup,
limitations, and recovery instructions.
