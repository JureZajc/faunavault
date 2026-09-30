# Catalog scale benchmark and query profiling

## Running the benchmark

From the repository root, with backend dependencies already installed:

```powershell
python scripts/dev.py benchmark-catalog --sizes 1000 10000 50000 --runs 20 --output catalog-benchmark-results.json
python scripts/dev.py benchmark-catalog --sizes 100000 --runs 20 --output catalog-benchmark-100k-results.json
```

Defaults are all four sizes and 10 measured iterations. `--sizes` accepts one or
more positive Photo counts; `--runs` accepts a positive iteration count. At least
20 iterations are required to report p95. `--verbose` additionally prints component
timings, emitted SQL, parameters, and raw plans. Without `--output`, results are
printed only. Use a **new** report filename when repeating a run: existing files
are deliberately never overwritten. Relative report paths refer to the invoking
working directory. The output parent directory must already exist.

The backend-only equivalent, from `backend`, is:

```powershell
uv run --no-sync python -m app.cli.benchmark_catalog --sizes 1000 --runs 20
```

No frontend, Ollama, GBIF, OpenStreetMap, image decoder, or external service is
needed. Large runs are developer-invoked and are never ordinary CI tests.

## Isolation and dataset

Every size gets a fresh file-backed database and empty image directories beneath
an owned system temporary directory. The harness imports production services,
but never the application/global engine. It runs the real storage initializer and
migrations before seeding: schema 13, normal foreign-key/busy-timeout behavior,
and all production indexes. It adds no indexes and does not run `ANALYZE` or alter
SQLite cache, journal, or planner settings.

Benchmark settings accept only explicit constructor arguments, ignoring dotenv
and environment configuration. A separate three-field settings reader inspects
configured database directory/data/image locations solely to reject unsafe temporary/report
destinations. There is no option to select an archive/database. Reports reject
managed state, existing files, links, and junctions; complete JSON is published
using an exclusive filesystem link from a flushed staging file. Engines/listeners
are closed and temporary state is removed on normal completion, exceptions, and
handled interruption. Forced process termination cannot guarantee cleanup.

Dataset version 1 uses seed `20260929`, explicit IDs, and fixed timestamps. Size
means **total** Photo rows, with exactly every twentieth Photo in Trash. Captures
span 2018–2026 with approximately 20% nulls. Category/species/taxonomy values are
correlated: fox/deer are common mammals; owl/robin common birds; bee, frog, lizard,
and carp supply less frequent categories/Taxa. Approximately 10% of categories
are null/empty/space-only, 10% of Photos have no Animal, and 25% of remaining
Animals have no linked Taxon. Linked Animals use the existing `manually_linked`
taxonomy status; unlinked Animals are `unreviewed`.

Statuses are weighted 75% classified, 15% pending, and 10% needs-review. Metadata
includes nullable confidence, varied titles/filenames/descriptions/tags, approximately
70% camera/lens coverage, approximately 35% paired GPS, dimensions, and capture
offsets. Filesize/hash/variant names are synthetic; **no physical images exist**.
Insertion uses bounded batches. Eight fixed edge records add capture boundaries,
ties, null captures, blank categories, and literal `%`, `_`, and backslash search.
The workload includes common `wildlife`, rare `alpine-rare`, conjunctive
`vulpes wildlife`, absent terms, Animal-only/Taxon-only matches, and a Trash-only
term. Tiny datasets are useful correctness fixtures, not performance evidence.

Before timing, an independent metadata oracle checks counts, ordered page IDs,
null-last/tie behavior, global facets, adjacent-page continuity, duplicates, Trash
exclusion, inclusive capture dates, and every saved-query/catalog pair. It also
checks Timeline month/year counts and previews, Map projections, and taxonomy
selector counts/order. A mismatch aborts the run before publishing JSON. The
oracle models SQLite's built-in ASCII `lower`/`NOCASE` behavior; catalog search is
not the separate Unicode-folding Album search.

## Scenarios and timing boundaries

There are 56 production scenarios per size:

- Default pages 1 and 3; pages around 50% and 90% of active results, with 48 Photos
  per page; all seven sort modes in both directions.
- Common/rare category and Taxon, uncategorized, all three statuses, inclusive
  2024 capture dates, and a combined category/status/Taxon/date filter.
- Rare/common/multiple/absent searches; search plus category, Taxon, dates, or name
  sorting; escaped literal characters, relationship-only matches, and Trash-only
  exclusion.
- Five persisted version-one Smart Collections: category, Taxon, date, text, and
  combined criteria, each paired with an equivalent normal catalog request.
- Smart Collection detail metadata, Timeline, Map, and taxonomy selector with
  selected-Taxon lookup.

The high-resolution monotonic `perf_counter_ns` timer measures fresh-session
service calls after two warmups. Measurements include all service SQL, fetching,
ORM hydration, and response-model construction. They exclude HTTP transport,
JSON encoding, browser rendering, image loading, and networking. These are
**warm-cache** results: no cold-cache or disk-cold claim is made. Minimum/maximum
and median are always reported; nearest-rank p95 is null below 20 iterations and
is a limited tail estimate even at 20 runs.

Catalog responses with positive totals contain five statements: filtered count,
bounded items, global status facets, global category facets, and active total.
R5 omits bounded items after an exact zero count, retaining all three global facet
statements; R4 always executed five. Smart pages add
saved-definition lookup/validation before this same path. The detail page displays
the response's `total`: there is **no separate live-count endpoint**. Isolated
filtered-count latency therefore differs from time until the displayed count is
available, which includes the page response and, on initial navigation, detail
metadata loading.

An untimed capture pass records actual SQLAlchemy statements plus emitted SQL and
parameters. Component diagnostics replay those statement objects in fresh
sessions and fully consume results; they never reconstruct filtering SQL.
Identical SQL/parameters are profiled once per dataset and reused in the report,
including shared facets and Smart/catalog components. Component timings omit
service query construction/response assembly and **must not be added together
as a substitute for full-service measurements**. Profiling listeners are removed
before headline timing. `EXPLAIN QUERY PLAN` describes index/candidate access,
joins, scans, and temporary B-trees; it does not establish operator durations.

Schema/storage setup, generation/insertion, correctness validation, diagnostics,
and measured execution durations are reported separately. The oracle and dataset
are retained in memory, so generation/validation time and process memory are not
application query costs. There is no concurrent-write/load model.

JSON format version 1 contains environment/revision, seed/dataset version,
methodology, distributions, schema/pragmas/index definitions, phase durations,
scenario criteria/counts/page/offset, timings, raw SQL/plans, Smart comparisons,
and independent area assessments. It contains no private filesystem paths or
archive contents. Assessments conservatively use the selected **500 ms median**
reporting guideline: an over-budget result needs dedicated investigation until
measurements and plans establish a small safe fix. The harness does not claim a
small optimization exists solely because a scan or sort appears in a plan.

## R4 representative measured results (preserved baseline)

Runs on 2026-09-29 used Windows 11/AMD64, Python 3.12.10, SQLite 3.49.1,
schema 13, and the working tree based on revision
`7a513975c6c5fd57037ae0fd49d2a13909e2f063` containing this new harness.
Each scenario used 20 measured iterations and two warmups. SQLite settings were
unchanged: DELETE journal, synchronous 2, cache size -2000, 4096-byte pages,
automatic indexes on, foreign keys on, 5000 ms busy timeout, and temp store 0.
The generated JSON reports contain every scenario's min/max, counts, components,
parameters, and raw plans; machine-specific reports are ignored by Git.

Service timings below are **median / p95 in milliseconds**. All four sizes
completed, with 56 validated service scenarios per size and no correctness
failures. The 100k dataset contained 95,000 active and 5,000 Trash Photos,
89,927 Animals (67,302 linked to Taxa), 19,823 missing capture dates, and
35,100 GPS Photos including Trash. The same eight local Taxa and five saved
definitions are used at every size; this does not model hundreds of distinct
species or thousands of saved collections.

| Scenario | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Default first page | 1.57 / 2.73 | 2.79 / 3.29 | 10.89 / 11.76 | 20.22 / 20.86 |
| Slowest sort (name desc) | 2.91 / 4.27 | 8.79 / 9.37 | 33.46 / 34.76 | 67.01 / 68.91 |
| Category: mammal | 1.78 / 2.28 | 2.67 / 3.73 | 10.41 / 10.92 | 20.61 / 21.56 |
| Taxon: common | 1.97 / 3.56 | 30.82 / 31.65 | 215.67 / 218.15 | 469.73 / 500.16 |
| Taxon: rare | 1.82 / 2.83 | 33.76 / 37.66 | 221.07 / 224.62 | 464.95 / 470.48 |
| Capture date range | 2.30 / 2.79 | 5.49 / 6.35 | 23.36 / 23.99 | 46.73 / 49.64 |
| Rare search | 12.19 / 13.13 | 124.75 / 127.63 | 680.25 / 702.66 | 1148.74 / 1192.65 |
| Common search | 4.63 / 5.54 | 44.42 / 45.72 | 278.68 / 286.45 | 601.16 / 620.29 |
| Multiple-term search | 9.31 / 10.48 | 71.79 / 74.75 | 398.15 / 405.98 | 835.67 / 872.62 |
| No-result search | 11.80 / 12.55 | 122.65 / 125.03 | 671.28 / 687.65 | 1403.89 / 1437.64 |
| Search + name sort | 6.80 / 22.24 | 61.01 / 62.57 | 365.97 / 436.47 | 754.92 / 767.27 |
| Deep page (~90%) | 1.64 / 2.34 | 3.02 / 3.67 | 12.58 / 12.97 | 24.40 / 25.16 |

Smart pages include the count and global facets, just like catalog pages.
Saved date/combined definitions use captured-time sorting; each paired catalog
request uses exactly the same criteria and sorting:

| Scenario | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Smart category page | 2.04 / 2.57 | 2.99 / 3.55 | 10.69 / 11.13 | 21.23 / 23.40 |
| Smart Taxon page | 2.20 / 3.27 | 31.06 / 32.20 | 214.92 / 217.23 | 469.51 / 484.56 |
| Smart date page | 2.42 / 3.02 | 6.74 / 7.58 | 29.59 / 30.60 | 59.39 / 60.60 |
| Smart text page | 4.93 / 5.59 | 44.10 / 45.34 | 277.96 / 287.16 | 586.84 / 607.79 |
| Smart combined page | 3.46 / 4.55 | 11.03 / 11.67 | 48.39 / 49.62 | 100.59 / 108.47 |
| Smart detail metadata | 0.23 / 0.43 | 0.21 / 0.23 | 0.22 / 0.36 | 0.26 / 0.42 |

Independent filtered-count components, **median / p95 milliseconds**:

| Count | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Default active count | 0.15 / 0.17 | 0.32 / 0.43 | 1.09 / 1.28 | 2.05 / 2.34 |
| Rare search count | 4.84 / 5.73 | 72.12 / 73.33 | 430.90 / 440.23 | 886.89 / 900.71 |
| No-result search count | 4.92 / 6.25 | 71.72 / 73.59 | 424.46 / 432.81 | 922.53 / 952.91 |
| Smart text live count | 1.51 / 2.31 | 39.20 / 40.83 | 269.81 / 280.11 | 562.91 / 568.23 |

The 562.91 ms isolated Smart count at 100k is part of the 586.84 ms page
response; the UI cannot display the count independently sooner. Initial detail
metadata lookup adds approximately 0.26 ms of service work, excluding transport.

| Supporting service | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Timeline | 4.97 / 5.78 | 31.40 / 32.39 | 198.84 / 203.95 | 413.77 / 429.62 |
| Map | 2.23 / 2.65 | 24.07 / 48.66 | 186.79 / 197.30 | 377.86 / 497.74 |
| Taxonomy selector | 1.81 / 2.28 | 58.09 / 60.03 | 433.44 / 439.26 | 930.97 / 966.39 |

Phases below are elapsed **seconds**, including warmup/capture work in the
corresponding profiling/execution phases. They are not per-request timings:

| Phase | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Storage/schema/index setup | 0.36 | 0.35 | 0.35 | 0.36 |
| Dataset generation/insertion | 0.05 | 0.35 | 1.93 | 4.13 |
| Correctness validation | 0.55 | 3.93 | 21.45 | 44.37 |
| Diagnostic profiling | 2.97 | 30.72 | 177.25 | 361.90 |
| Benchmark execution | 4.91 | 36.01 | 203.18 | 416.53 |

These four 20-run measurements accounted for about 22 minutes in reported
phases. For a quick correctness/tooling run, use `--sizes 1000 --runs 3`;
do not use that small run to draw large-archive performance conclusions.

### Query-plan findings

- Default created-time retrieval uses `ix_photo_catalog_active_created` without
  a temporary sort. At 50k, first-page retrieval alone was 0.61 ms; status/category
  facets were 3.73/3.63 ms and active/default filtered counts were 1.09 ms each.
  Much of the 10.89 ms full response is the legitimate global facet/count work.
- Category/status filters use their existing compound indexes. Capture filters
  use `ix_photo_catalog_active_captured`; captured/name/species/confidence/priority
  sorts can need temporary B-trees because of expressions and tie-breaking.
  The slowest full sort at 50k was name descending, 33.46 ms median.
- Taxon count plans start with a broad active-Photo candidate traversal, then
  Animal/Taxon primary-key lookups. At 50k, common/rare Taxon count components
  were 205.62/204.93 ms, while their page retrieval was 0.76/3.56 ms. Existing
  relationship indexes are present; the count planner does not start with the
  selective Animal Taxon index for these queries. This is a count/join access
  issue to investigate, rather than evidence of a missing production index.
- Unrestricted search counts likewise traverse active candidates through the
  captured-time index with relationship lookups. The leading-wildcard,
  lower/coalesce predicates do not provide a text-index lookup. Default ordered
  page retrieval uses the created-time index, but a rare/absent term may require
  examining most candidates in both the count and items queries. At 50k, rare
  search count/items components were 430.90/237.38 ms; absent search components
  were 424.46/234.36 ms. These diagnostics identify count/candidate/predicate work
  as expensive; they do not separate every join or predicate's CPU duration.
- Adding a date/category filter narrows candidate access. Name-sorted common
  search requires a temporary sort and measured 82.05 ms for retrieval at 50k,
  alongside the same 269.81 ms common-search count component.
- Default OFFSET retrieval retains the ordered index plan. At 50k, offset 42,720
  took 1.55 ms for retrieval and 12.58 ms for the complete response. This does not
  justify a cursor-pagination rewrite.
- Smart Collection pages add one primary-key saved-definition lookup and then
  emit the equivalent catalog statements. At 50k, all five sequential median
  differences were below 2 ms; detail metadata loading was 0.22 ms. There is no
  measured Smart-specific architecture penalty. Shared component measurements
  are reused intentionally, not presented as independent equal timing samples.
- Timeline uses three statements; month grouping and ranked preview windows use
  temporary B-trees. At 50k, previews were 172.71 ms of a 198.84 ms service call.
  Map returns one projection of all GPS Photos: 16,685 points and 186.79 ms at
  50k, including response-model construction. Taxonomy selector count/grouping
  repeats broad active joins and took 433.44 ms at 50k; selected-Taxon lookup was
  only 0.36 ms. Browser clustering, JSON payload transfer, and rendering were not
  measured.

At 100k, default count/facet components remained small: 2.05 ms for an active
count and 7.14/7.01 ms for status/category facets. Offset 85,488 (page 1782)
retained the created-time index plan: 4.29 ms retrieval, 24.40 ms full response.
In contrast, no-result search count/items were 922.53/482.64 ms. The common
search count was 562.91 ms although first-page retrieval was only 0.86 ms.
The rare search page stops after 48 of 96 matches, but counting all matches
still cost 886.89 ms.

The 100k category/date/text/combined Smart pairs differed by approximately
0.42, 0.64, -0.25, and 1.71 ms, respectively. The Taxon pair differed by
8.13 ms (1.8%): catalog/Smart medians were 461.38/469.51 ms, while p95 values
were 485.06/484.56 ms and ranges overlapped. The extra saved-definition query
was approximately 0.15 ms. These sequential results are consistent with timing
variation and lookup/validation overhead, with no evidence of additional
Smart-specific result-query work. Sparse/absent saved searches were not timed
as separate definitions; their equivalent catalog path identifies the shared
scaling risk without claiming an independent measurement.

### Assessments and next branch

These conclusions apply to this synthetic workload and implementation environment,
using the selected 500 ms **median** guideline. They do not establish universal
latency guarantees or browser responsiveness.

| Area | Classification | Evidence |
| --- | --- | --- |
| Default catalog browsing | No action needed | At 100k, first page 20.22 ms and slowest sort 67.01 ms; existing index access and bounded hydration are adequate. |
| Filtered catalog | No action needed under the guideline | Category/date queries remain inexpensive. Taxon filters approach the limit (469.73 ms median, 500.16 ms p95), dominated by joined counts; include that shared cost in the count follow-up. |
| Text search | Requires a dedicated follow-up | All measured 10k searches stayed below 125 ms median. Sparse/absent 50k searches exceed 500 ms; at 100k common, multiple-term, sparse, and absent searches exceed it. |
| Deep pagination | No action needed | Offset 85,488 adds about 4.18 ms to the 100k first-page service median, with no temporary sort for the default order. |
| Catalog counts | Requires a dedicated follow-up | Default counts/facets are small, but 100k search counts reach 922.53 ms. Taxon count joins also cost approximately 448 ms and the taxonomy selector reaches 930.97 ms. |
| Smart Collection result queries | Requires a dedicated follow-up for shared text-search scaling | Common saved text search reaches 586.84 ms at 100k; equivalent catalog work has comparable timing/plans. No separate Smart Collection architecture change is justified. |
| Smart Collection live counts | Requires a dedicated follow-up for shared count scaling | Common saved search count is 562.91 ms at 100k and arrives with the full page response. Other measured saved definitions remain below the guideline. |

No area is labeled "worth a small optimization" solely from an expensive plan:
this slice establishes costs without demonstrating a safe fix and before/after
improvement. Current substring search is adequate for the measured 10k personal
archive workload, but that conclusion cannot be extended to all 50k/100k searches.

The recommended next branch is **Catalog count access and substring-search
scaling**. Use this same harness to investigate broad joined-count candidate
access (including the taxonomy selector), compare existing indexed access paths
in disposable state, and evaluate avoiding the items query after an exact zero
count. Distinguish those costs from residual substring evaluation before choosing
a fix. Any production change must retain result/count/sort/lifecycle semantics,
pass focused tests, and show before/after evidence. A benchmark-only FTS comparison
is a possible later experiment only if residual matching cost warrants it and
literal substring semantics can be retained; neither FTS deployment, new indexes,
caching, nor cursor pagination is an established recommendation from this slice.

### Validation

The targeted benchmark/tooling/catalog/Smart Collection suite passed **57 tests**
with **one** Windows symlink-capability skip. The harness adds 27 collected tests
and root-command integration adds six cases. They cover determinism, relationships,
current indexes, all scenarios, deliberately wrong responses, production-service
use, live membership changes, statement replay, cleanup including interruption,
configuration isolation, unsafe output refusal, CLI behavior, and JSON statistics.

`python scripts/dev.py check` passed: backend Ruff lint/format, **356 backend tests
passed and six platform skips**, frontend lint/typecheck, **111 frontend tests**,
and production build. Existing Starlette dependency and frontend navigation lint
warnings remain. No wall-clock CI thresholds or large CI benchmarks were added.

Production queries/schema are unchanged; there is no before/after optimization
claim. Experimental FTS was deliberately not tested in this measurement-only
slice. Follow-up search/count experiments must preserve current substring,
escaped-literal, conjunctive-term, relationship-field, and Trash semantics.

## R5: Catalog count access and substring-search scaling

R5 measurements on 2026-09-30 use the same runtime, SQLite settings, schema 13,
dataset version 1, seed, correctness oracle, warm-cache boundaries, fresh sessions,
two warmups, and 20 measured iterations as R4. The original R4 tables and reports
above remain the historical baseline. New complete before/after reports are
`catalog-benchmark-r5-before.json` and `catalog-benchmark-r5-after.json`; the
separate ablation report is `catalog-benchmark-r5-ablations.json`. These local
reports are ignored by Git and retain full SQL, parameters, plans, counts,
median/p95/min/max, distributions, and schema/index metadata. The full baseline
was completed before editing production queries. Runs are sequential, without
concurrent tests or benchmarks. The harness's `production_changes: false` flag
means the harness itself adds no production changes or experimental indexes;
the after report measures the modified R5 production service.

### Root causes and selected changes

- Broad counts selected the active capture-time index, fetched Photo records out
  of row order, and looked up Animal and Taxon rows for each candidate. A count
  with the same joins but no text predicate is already expensive. The existing
  covering active-ID and relationship indexes are sufficient for better access.
- Unrestricted text counts now obtain active IDs with a covering lookup and
  fetch Photo rows through primary-key access. Per-term Animal/Taxon membership
  subqueries reuse relationship matches instead of repeating joined lookups for
  every Photo. Predicates still use the original 25 fields, JSON tags cast,
  lower/coalesce, escaped literal substring matching, and conjunctive terms.
  Different terms can still match different Photo/Animal/Taxon fields.
- Taxon counts without additional Photo filters use a Photo-ID subquery driven
  by the Taxon primary key, `ix_animal_taxon_id`, and `ix_photo_animal_id`. The
  outer count excludes Trash through existing active access. Text on this path
  retains the original joined predicates over those matching candidates.
- Status/category/uncategorized/date filters retain their original count
  formulations and selective access. Item-query SQL, sorting, and pagination
  remain unchanged. After an exact zero count, the items query is omitted while
  global facets still execute. Positive out-of-range pages retain the items query.
- Taxonomy counts group active Photos by Animal's Taxon ID through primary-key
  Photo access, then join those small groups to Taxon for availability, labels,
  counts, sorting, and pagination. No records are grouped in Python. This removes
  broad Taxon/label grouping and `count(DISTINCT Taxon.id)` from the old paths.
  The selected-Taxon lookup remains unchanged, including zero-count selections.
- Smart Collections still perform one saved-definition lookup before calling
  the shared catalog service. No Smart-specific query or endpoint was added.

### Experiments and rejected approaches

Exploratory 50k/100k comparisons used the existing disposable dataset, oracle,
statement replay, timer, and EXPLAIN tooling, initially with five measured runs.
Those exploratory medians do not replace the paired 20-run production tables.
They compared unchanged counts, forced table scans, per-term membership,
membership plus active Photo-ID access, Taxon Photo-ID access, and taxonomy
correlated counts versus grouping. Full-service prototypes then checked all 56
scenarios and Smart parity at 10k/50k/100k before selecting production changes.

- `NOT INDEXED` reduced scattered Photo access, but forcing a scan unnecessarily
  constrains future planner choices and selective paths. Equivalent improvement
  is available through existing indexed active-ID/primary-key access, so no
  production hint is included.
- Simple Animal-ID membership alone retained broad capture-index Photo access.
  For example, the exploratory 100k rare count fell from about 847 ms to 476 ms,
  but active-ID/primary-key access plus membership reduced it to about 283 ms.
  Membership alone was therefore not selected.
- Correlated taxonomy counts with inner joins caused a broad Photo traversal per
  Taxon and measured about 2003 ms for items at 100k. Grouping once per statement
  by Taxon ID measured about 49 ms and scales without repeating that traversal
  for every displayed Taxon. The grouped SQL formulation was selected.
- Zero-result skipping alone removes the redundant item traversal but leaves the
  original dominant count. The ablation below measures it separately from count
  access changes and their combined effect.
- No new-index experiment or index addition was needed after these comparisons.
  Schema version, migrations, backup verification/rehearsal, fresh-schema
  contracts, and dataset setup remain unchanged.
- FTS5 was not investigated or introduced in R5. These small SQL changes produce
  material gains while retaining exact substring semantics. A possible later
  FTS comparison remains separate and must establish literal-character, short
  substring, case, conjunction, and relationship-field compatibility before any
  migration recommendation.

### R5 validation

The focused catalog/Smart Collection/benchmark/taxonomy suite passed **109 tests**
with **one** platform skip. R5 adds **45** collected cases: all 25 searchable
fields on broad, Taxon/text, and selective count paths; literal escapes and
conjunctive cross-table terms; SQLite's current non-ASCII case behavior; missing
relationships, shared Animals, Trash/restore, combined filters, pagination,
taxonomy availability/labels/selected zero counts; complete Smart/catalog parity;
and zero-count query omission with global facets retained. Positive out-of-range
pages still execute items. Capture tests also reject unexpected extra statements
and verify listener cleanup. No brittle plan assertions or timing thresholds were
added to CI.

`python scripts/dev.py check` passed on 2026-09-30: backend Ruff lint/format,
**401 backend tests passed with six platform skips**, frontend lint/typecheck,
**111 frontend tests**, and the production build. Existing Starlette, frontend
navigation lint, and Vite plugin warnings remain outside this branch's scope.

### R5 paired measurements

Cells show **before → after median / p95 milliseconds**, rounded to two decimals.

| Full service | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Taxon common | 1.98 / 2.31 → 1.92 / 2.36 | 29.26 / 30.52 → 3.44 / 4.23 | 202.58 / 204.91 → 14.06 / 14.61 | 462.99 / 473.15 → 28.00 / 32.25 |
| Taxon rare | 1.74 / 2.35 → 1.65 / 2.22 | 31.75 / 32.21 → 6.31 / 7.06 | 202.12 / 203.75 → 13.58 / 13.84 | 471.35 / 495.32 → 22.69 / 24.10 |
| Taxonomy selector | 1.77 / 1.97 → 1.67 / 2.07 | 56.48 / 71.76 → 11.32 / 12.17 | 451.24 / 663.91 → 52.13 / 53.20 | 898.12 / 906.72 → 106.62 / 108.15 |
| Common search | 4.53 / 5.01 → 4.97 / 5.35 | 42.12 / 43.56 → 18.95 / 20.96 | 266.11 / 271.66 → 79.47 / 82.26 | 588.31 / 613.78 → 153.95 / 155.74 |
| Rare search | 11.26 / 11.79 → 10.59 / 11.18 | 117.38 / 118.08 → 79.85 / 81.72 | 651.27 / 654.08 → 387.88 / 391.78 | 1154.59 / 1185.61 → 533.98 / 540.54 |
| No-result search | 10.74 / 11.32 → 5.12 / 6.72 | 115.87 / 117.22 → 32.54 / 33.97 | 648.77 / 673.32 → 152.58 / 154.34 | 1382.43 / 1421.35 → 298.38 / 301.65 |
| Multiple-term search | 8.39 / 8.71 → 8.69 / 9.70 | 66.61 / 67.93 → 35.84 / 37.07 | 381.38 / 387.33 → 154.37 / 157.65 | 825.44 / 835.84 → 301.34 / 303.47 |
| Search + Taxon | 4.47 / 5.23 → 4.70 / 5.21 | 41.18 / 41.96 → 11.56 / 12.66 | 253.85 / 256.79 → 41.46 / 42.76 | 569.57 / 579.04 → 80.92 / 81.97 |
| Smart text page | 4.51 / 4.79 → 5.22 / 6.58 | 43.31 / 46.55 → 19.39 / 20.10 | 292.88 / 389.82 → 79.65 / 81.85 | 568.72 / 615.05 → 156.01 / 157.70 |
| Smart Taxon page | 2.23 / 2.80 → 2.17 / 3.09 | 29.64 / 30.63 → 3.63 / 4.85 | 211.74 / 214.99 → 14.44 / 16.48 | 439.21 / 446.95 → 27.73 / 28.62 |

Component diagnostics are measured separately; they are not additive service totals.

| Component | 10k | 50k | 100k |
| --- | ---: | ---: | ---: |
| Taxon common count | 25.88 / 26.71 → 0.76 / 1.00 | 192.12 / 194.23 → 3.68 / 4.12 | 442.86 / 451.19 → 9.53 / 9.98 |
| Taxon rare count | 25.74 / 26.55 → 0.17 / 0.37 | 191.38 / 193.40 → 0.27 / 0.44 | 451.58 / 470.21 → 0.43 / 0.52 |
| Rare search count | 68.43 / 69.48 → 29.03 / 30.03 | 401.24 / 406.46 → 140.60 / 142.89 | 891.09 / 907.39 → 282.48 / 286.38 |
| Common search count | 37.54 / 38.21 → 13.56 / 14.40 | 254.21 / 264.92 → 67.83 / 69.98 | 569.02 / 577.30 → 133.85 / 136.58 |
| No-result search count | 67.51 / 68.70 → 28.87 / 31.43 | 408.29 / 418.28 → 142.62 / 144.01 | 879.58 / 886.88 → 279.99 / 282.68 |
| Smart text live count | 37.54 / 38.21 → 13.56 / 14.40 | 254.21 / 264.92 → 67.83 / 69.98 | 569.02 / 577.30 → 133.85 / 136.58 |
| Rare search items | 45.87 / 46.64 → 47.07 / 48.59 | 233.26 / 234.93 → 232.38 / 236.59 | 237.64 / 238.82 → 229.94 / 233.33 |
| Taxonomy availability count | 26.13 / 26.45 → 5.09 / 5.64 | 211.55 / 219.05 → 24.49 / 24.93 | 429.10 / 444.22 → 51.45 / 52.00 |
| Taxonomy page/grouping | 29.30 / 31.90 → 4.98 / 5.28 | 229.29 / 234.95 → 25.19 / 26.55 | 460.18 / 466.70 → 51.97 / 52.64 |
| Selected Taxon | 0.18 / 0.19 → 0.18 / 0.20 | 0.30 / 0.54 → 0.30 / 0.33 | 2.36 / 3.02 → 2.37 / 2.78 |

### Regression measurements

| Full service | 1k | 10k | 50k | 100k |
| --- | ---: | ---: | ---: | ---: |
| Default first page | 1.54 / 2.02 → 1.58 / 1.77 | 2.68 / 3.25 → 2.88 / 3.44 | 10.68 / 11.27 → 10.28 / 11.00 | 20.50 / 21.80 → 19.44 / 19.99 |
| Deep page (~90%) | 1.58 / 1.79 → 1.62 / 2.02 | 2.87 / 3.38 → 2.95 / 3.54 | 12.29 / 12.96 → 12.53 / 13.03 | 23.91 / 24.80 → 23.16 / 24.00 |
| Category mammal | 1.58 / 1.91 → 1.60 / 1.79 | 2.64 / 3.26 → 2.67 / 3.51 | 10.00 / 10.57 → 10.54 / 11.42 | 20.62 / 21.52 → 20.18 / 21.84 |
| Capture date range | 1.77 / 2.23 → 1.80 / 2.17 | 5.25 / 5.64 → 5.19 / 6.42 | 21.36 / 22.06 → 22.59 / 23.50 | 46.70 / 49.07 → 44.13 / 45.85 |
| Name descending | 2.26 / 2.86 → 2.35 / 3.32 | 8.18 / 8.67 → 8.14 / 9.00 | 31.59 / 32.72 → 32.73 / 33.49 | 66.23 / 67.51 → 63.46 / 65.25 |
| Search + date | 3.46 / 4.51 → 3.53 / 4.21 | 13.01 / 13.72 → 13.63 / 14.15 | 65.39 / 68.66 → 67.39 / 68.65 | 142.84 / 147.05 → 135.46 / 137.92 |
| Combined filter | 1.52 / 2.09 → 1.54 / 1.69 | 6.75 / 7.37 → 7.42 / 8.12 | 33.04 / 34.20 → 34.71 / 35.63 | 74.99 / 77.11 → 70.58 / 71.84 |
| Smart combined | 3.21 / 3.81 → 3.24 / 3.72 | 10.47 / 11.26 → 10.80 / 11.58 | 50.52 / 52.51 → 47.27 / 48.10 | 93.09 / 95.52 → 94.20 / 96.05 |

### Zero-result ablation and traversal diagnostics

The same disposable database is used for four sequential service variants at each size,
with two warmups, 20 iterations, fresh sessions, and the independent oracle. Baseline
source was saved before production edits. `Count only` forces execution of the unchanged
items query; `skip only` uses the old count; `combined` is the production service.

| No-result full service | 10k | 50k | 100k |
| --- | ---: | ---: | ---: |
| baseline | 115.96 / 118.29 | 639.93 / 644.36 | 1316.68 / 1329.58 |
| count only | 77.00 / 78.63 | 377.93 / 380.84 | 751.82 / 760.22 |
| zero only | 71.71 / 72.85 | 417.12 / 421.68 | 855.94 / 869.52 |
| combined | 31.57 / 32.70 | 149.51 / 150.75 | 298.55 / 300.85 |

| Diagnostic count (not service latency) | 10k | 50k | 100k |
| --- | ---: | ---: | ---: |
| active covering count | 0.32 / 0.34 | 1.06 / 1.19 | 2.00 / 2.03 |
| joined active count without search | 26.42 / 27.10 | 196.26 / 198.07 | 424.01 / 433.88 |

These diagnostics change the queried work and cannot be subtracted to assign exact
CPU durations to individual operators. They show that candidate/relationship access
is expensive even before substring predicates are added. No-result items are
absent from the final production capture, rather than assigned a synthetic zero timing.

### Plan changes and remaining costs

Representative captured count plans changed as follows (the JSON retains full
plans, node IDs, SQL, and parameters for every scenario):

```text
Broad search before:
  SEARCH photo USING INDEX ix_photo_catalog_active_captured (deleted_at=?)
  SEARCH animal USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
  SEARCH taxon USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
Broad search after:
  SEARCH photo USING INTEGER PRIMARY KEY (rowid=?)
  LIST SUBQUERY: SEARCH photo USING COVERING INDEX ix_photo_deleted_at (deleted_at=?)
  LIST SUBQUERY: SCAN animal
  LIST SUBQUERY: SCAN taxon

Taxon count before:
  SEARCH taxon USING INTEGER PRIMARY KEY (rowid=?)
  SEARCH photo USING INDEX ix_photo_catalog_active_captured (deleted_at=?)
  SEARCH animal USING INTEGER PRIMARY KEY (rowid=?)
Taxon count after:
  SEARCH photo USING COVERING INDEX ix_photo_deleted_at (deleted_at=? AND rowid=?)
  LIST SUBQUERY:
    SEARCH taxon USING INTEGER PRIMARY KEY (rowid=?)
    SEARCH animal USING COVERING INDEX ix_animal_taxon_id (taxon_id=?)
    SEARCH photo USING COVERING INDEX ix_photo_animal_id (animal_id=?)
```

The taxonomy selector now groups only Taxon IDs before joining labels, using
Photo primary-key access plus a covering active-ID list. It retains a temporary
GROUP BY B-tree and a small label ORDER BY B-tree, but removes the old broad
Taxon/Photo joins and distinct-Taxon count. Availability/page component medians
at 100k fell from 429.10/460.18 ms to 51.45/51.97 ms; selected lookup remained
2.36/2.37 ms. Item query plans and selective Photo-filter count plans are unchanged.

At 100k, common/rare Taxon counts fell from 442.86/451.58 ms to 9.53/0.43 ms.
Rare/common/no-result search counts fell from 891.09/569.02/879.58 ms to
282.48/133.85/279.99 ms. Smart's saved-definition lookup remained about 0.15 ms;
all five 100k saved/catalog pairs differed by less than 1 ms, and their shared
component SQL/counts agree. The UI still receives its exact live count with the
complete page, without a separate endpoint or asynchronous count mechanism.

All 56 scenarios passed the independent correctness oracle at each size, including
adjacent-page continuity and complete saved/catalog parity. Before/after reports
have identical scenario criteria/counts, distributions, schema/index definitions,
and methodology. No material regression was observed in already-fast paths:
100k first/deep/category/date/name-desc medians changed from
20.50/23.91/20.62/46.70/66.23 ms to 19.44/23.16/20.18/44.13/63.46 ms.
All 14 ordinary sort medians improved at 100k. Some 50k sorts varied upward by
up to 2.74 ms, with unchanged SQL. Small-archive count construction adds modest
overhead: 1k common/Smart text pages changed from 4.53/4.51 ms to 4.97/5.22 ms.
These sequential measurements are bounded synthetic evidence, not a latency
guarantee for every archive or concurrency pattern.

Under the same 500 ms median reporting guideline, measured catalog counts and
Smart result/live-count scenarios no longer require count-access follow-up.
Positive sparse text results remain expensive: 100k rare search is 533.98 ms,
including a 282.48 ms diagnostic count and 229.94 ms diagnostic items query.
The slowest 100k text service is literal backslash search at 757.74 ms, compared
with 1295.44 ms before R5. Those positive results still execute the original
leading-wildcard item traversal; no-result searches avoid it entirely.
Relationship membership and Photo substring evaluation remain linear, and
taxonomy aggregation is still evaluated once for total and once for the page.

The recommended next step is to keep these measured SQL changes and assess
whether sparse positive-result latency needs further work. If it does, use a
separate branch to isolate item traversal and residual substring matching with
the same harness. An FTS comparison is conditional, not an established remedy;
production FTS, new indexes, caching, cursor pagination, and unrelated fast-path
optimization are not justified by this R5 result alone.
