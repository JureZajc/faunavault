# Photo curation query profile

Measured on 2026-09-30 with database schema 16, using disposable synthetic
10k/100k archives, 20 warm-cache iterations after two warmups. The focused
profile reuses the existing dataset and production catalog/Smart services,
checks result counts independently, and asserts catalog/Smart response parity.
No live archive, image decoding, external service, new join, or new index is used.

| Photos | Query | List median ms | Smart median ms |
| --- | --- | ---: | ---: |
| 10,000 | default | 2.96 | 3.22 |
| 10,000 | favorites | 19.20 | 19.82 |
| 10,000 | exact_5 | 19.73 | 19.27 |
| 10,000 | minimum_4 | 20.52 | 20.05 |
| 10,000 | unrated | 19.48 | 19.44 |
| 10,000 | rating_desc | 7.55 | 8.08 |
| 10,000 | rating_asc | 7.70 | 7.91 |
| 100,000 | default | 20.60 | 20.72 |
| 100,000 | favorites | 270.27 | 269.87 |
| 100,000 | exact_5 | 265.54 | 270.77 |
| 100,000 | minimum_4 | 282.53 | 275.83 |
| 100,000 | unrated | 266.12 | 271.30 |
| 100,000 | rating_desc | 58.66 | 60.26 |
| 100,000 | rating_asc | 58.91 | 59.44 |

Rating sorts use the existing active-photo index and a temporary ordering
B-tree. Curation counts use the existing active capture index and examine active
candidates. No relationship joins were introduced. At 100k, filtered page/count
responses remained below the existing 500 ms median reporting guideline; rating
sorts took about 59–60 ms. Smart queries tracked ordinary catalog cost.

No production index is justified for this iteration. These are synthetic
warm-cache service measurements on this machine, not end-to-end guarantees.
Reconsider indexing if measured archive behavior requires lower latency.

Reproduce from `backend` with:

```powershell
uv run --no-sync python -m app.cli.profile_photo_curation
```

Full timings, p95, and query plans are in
[catalog-benchmark-photo-curation.json](../catalog-benchmark-photo-curation.json).
The full large catalog benchmark suite was not rerun.
