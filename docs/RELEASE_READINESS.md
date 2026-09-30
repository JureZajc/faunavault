# v0.1.0 release-readiness implementation report

Validated on 2026-09-30 on Windows, using backend Python 3.12.10, Node 24.12.0,
and uv 0.11.21. The root command was launched with Python 3.14.0.

1. **Authoritative version:** `backend/pyproject.toml` owns `0.1.0`.
   `app.version` reads the source manifest or installed package metadata, without
   Git or a hardcoded fallback. `/health`, OpenAPI, and new backup manifests use
   it. The private frontend's independent version was removed from both manifests.

2. **First run:** install Python 3.12+, uv, and Node 24+/npm; clone; run
   `python scripts/dev.py setup`, then `python scripts/dev.py doctor`; start
   `backend` and `frontend` in separate terminals. Setup uses frozen dependencies.
   Backend defaults to localhost, SQLite at `backend/data/faunavault.db`, and
   images at `backend/data/images`. Existing overrides retain precedence.

3. **Initialization:** normal backend lifespan is still authoritative. It creates
   necessary storage, applies ordered migrations, preserves successful migration
   history and originals, and performs existing startup recovery. No reset/init
   command was added. Populated databases with absent/empty implicit portable
   originals are refused before writes, with an explicit `IMAGE_DIR` instruction.

4. **Doctor:** the new root command composes setup checks with existing maintenance
   tooling. Default checks are read-only and print PASS/WARNING/FAIL/OPTIONAL.
   `--archive` invokes the existing full cold archive doctor; `--ollama` explicitly
   probes optional service/models. Missing Ollama, malformed optional URLs, and
   missing models do not fail core readiness. Permission checks are advisory.
   The root doctor completed successfully against the configured archive, with
   schema 13, an advisory permission warning, and Ollama left unprobed.

5. **README:** the shorter first-run page retains the screenshot and verified
   inventory and explains setup, startup, import, optional AI, recovery,
   development, and limitations. Deep material moved to
   [Operations](OPERATIONS.md). Subsystem links and stale export/network claims
   were corrected; the unused root environment example was retired.

6. **Release notes and licensing:** [CHANGELOG](../CHANGELOG.md) contains the
   prepared 0.1.0 release notes. MIT licensing and project license metadata were
   added; the HEIC fixture retains its BSD-3-Clause text. No release date or
   publication is claimed by the changelog.

7. **Schema/migrations:** schema remains 13. Fresh lifespan verifies migrations
   1–13, catalog/relationship indexes, classification/review fields, manual
   Collections, and Smart Collections. Existing historical migrations remain
   intact. Genuine schema 10–12 copies now exercise the upgrade chain; a test
   previously named for schema 10 was corrected because it uses current schema.

8. **Backup/recovery:** format v1 still supports schemas 9–13. Tests cover creation,
   verification, isolated rehearsal, interrupted-job recovery, healthy doctor,
   originals/previews, active/Trash state, Collections, capture/review metadata,
   and Smart definitions. Verification now rejects claimed schema 12/13 without
   review columns or complete Smart structure before rehearsal writes. The
   committed historical backup fixture was not changed.

9. **Importer/AI documentation:** the existing command and all six importer flags
   are documented, including recursive/dry-run behavior, exact/visual duplicates,
   untouched source files, cold import, and deferred classification queues.
   Optional Ollama setup, model checks, Review, bounded retries, explicit failure
   retry, and restart behavior are covered. No importer/AI feature was added.

10. **CI/release gate:** existing jobs remain, with backend validation using
    `--no-sync` after frozen installation. New pytest cases run in ordinary CI.
    The gate remains `python scripts/dev.py check` plus frontend `npm run test:e2e`;
    no redundant release command, benchmarks, or tag workflow was added. Hosted
    GitHub Actions still needs to run on the final reviewed commit.

11. **Privacy:** local environments, default generated archive contents,
    conventional backups/rehearsals, and benchmark reports are ignored. A targeted
    credential-pattern scan returned zero matches. The tracked database is only
    the intentional synthetic historical fixture. Existing portability tests
    passed for manifests/exports/reports without absolute source paths. No real
    archive or private report was added to the release files.

12. **Tests added:** 29 collected cases cover version/metadata reporting; isolated,
    offline fresh lifespan and repeated-start preservation; portable defaults and
    refusal before writes; setup status and exit behavior; optional AI including
    malformed URLs; root composition and missing dependencies; real intermediate
    schemas; and structural backup refusal. Environment cases use temporary
    state and fake services rather than depending on the developer's machine.

13. **Validation results:**

    | Command/check | Result |
    | --- | --- |
    | `python scripts/dev.py check` | Exit 0 |
    | Backend Ruff lint and format | Passed; 93 backend Python files formatted |
    | Backend pytest | 430 passed, 6 platform-dependent skips, 1 existing warning |
    | Frontend ESLint/typecheck | Passed; 1 existing navigation lint warning |
    | Frontend Vitest | 111 passed across 18 files |
    | Frontend production build | Passed |
    | `npm run test:e2e` from frontend | Exit 0; 3 Chromium tests passed |
    | Disposable first-run/schema/doctor and recovery coverage | Passed within pytest |
    | Root setup doctor | Exit 0; optional AI not probed |
    | `uv lock --check --offline` | Passed; 37 packages resolved, lock unchanged |
    | Frontend dependency lock comparison | Only independent version fields removed |
    | Documentation link targets and `git diff --check` | Passed |

    Existing advisories concern Starlette's httpx TestClient deprecation,
    album navigation lint, Vite's tsconfig-paths plugin, and Playwright color
    environment flags. Initial sandbox temporary-directory/cache access failures
    were resolved by running permitted checks with normal host access. Final
    product validation passed. The final normal build restored the ordinary API
    configuration after the smoke build.

14. **Maintainer actions remaining:** review/commit and merge this branch to
    `master`; require clean/current master and passing hosted CI; perform the
    documented clean-clone prerequisite/first-run rehearsal; review the changelog
    and license; create annotated `v0.1.0`; push the tag; manually publish the
    GitHub Release using the changelog entry; confirm the tag, notes, and generated
    source downloads. Exact commands are in [Release](RELEASE.md). No tag was
    created/pushed and no GitHub Release was published during implementation.

15. **Deferred:** installers/bundled runtimes, distribution containers,
    authentication/multi-user support, cloud sync, automatic updates, telemetry,
    automated production restore, new catalog/AI features, FTS/caching, and
    additional performance redesign. Existing R4/R5 measurements were summarized
    without rerunning benchmarks or introducing CI thresholds.
