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

Catalog responses contain five statements: filtered count, bounded items,
global status facets, global category facets, and active total. Smart pages add
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

## Representative measured results

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
