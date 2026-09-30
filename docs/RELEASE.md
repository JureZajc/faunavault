# Publishing a FaunaVault source release

FaunaVault distributes source through GitHub's generated source archives. There
is no installer, bundled runtime, container distribution, or automated publishing
workflow. Implementation and validation never create or push tags or releases.

The examples below target **v0.2.0**, dated **2026-09-30** in the changelog. For
future releases, substitute the intended application version, changelog entry,
tag, and notes after auditing the independent schema/backup/export contracts.
The published v0.1.0 tag, changelog entry, and
[historical readiness report](RELEASE_READINESS.md) remain unchanged.

## Validate the release commit

1. Review and merge the readiness changes into `master`. Stop development
   servers, especially the frontend before dependency installation on Windows.
2. From a clean checkout, run:

   ```sh
   git switch master
   git pull --ff-only
   git status --porcelain
   git rev-parse HEAD origin/master
   ```

   Require no pending changes and matching revisions for the intended release
   commit. Do not tag a dirty checkout or unrelated commit.
3. Confirm `backend/pyproject.toml` has `project.version = "0.2.0"` and its lock
   agrees. This manifest is the application version authority; the frontend has
   no separate release version. `/health`, OpenAPI, diagnostics, and new backup
   manifests use the shared reader. Schema 16, backup format v1, metadata export
   v7, and Smart query v1 are independently versioned.
4. Install locked dependencies and run the local gates:

   ```sh
   python scripts/dev.py setup
   python scripts/dev.py doctor
   python scripts/dev.py check
   cd frontend
   npx playwright install chromium
   npm run test:e2e
   npm run build
   npm audit
   npm audit --omit=dev
   cd ..
   git diff --check
   ```

   `check` includes backend lint/format/tests, frontend lint/typecheck/tests, and
   production build. The browser suite builds against a dedicated test API;
   the final normal build restores the ordinary API configuration. Require
   successful exits and review skips/warnings. `check-clean` may replace setup
   plus check when an existing checkout needs dependency replacement.
   Review live audit findings and remediate release-critical vulnerabilities.
   The v0.2.0 readiness audit records a current dependency security blocker;
   functional success alone does not clear it for publication.
5. Perform the fresh-clone rehearsal below without Ollama or personal data.
6. Require backup-v1 schemas 9–16 to verify and rehearse. The full check includes
   fresh schema, genuine historical upgrades, schema-13 failure/retry, structural
   refusal, recovery, and export tests. For focused diagnosis only:

   ```sh
   cd backend
   uv run --no-sync pytest tests/test_first_run.py tests/test_backup.py tests/test_restore_rehearsal.py tests/test_capture_metadata_editing.py tests/test_photo_curation.py tests/test_archive_export.py
   cd ..
   ```

   Do not repeat a current successful full result unnecessarily. Check originals,
   active/Trash state, Collections, Smart definitions, classification, duplicate
   decisions, effective/extracted capture/GPS, manual overrides and clears, and
   Favorites/Ratings. Required structures must be checked even in empty backups.
   Never regenerate the frozen schema-9 fixture or weaken historical support.
7. Review the dated v0.2.0 changelog, README limitations,
   [readiness report and prepared notes](RELEASE_READINESS_V0.2.0.md), MIT license,
   and HEIC fixture's BSD-3-Clause notice. Inspect `git ls-files` for accidental
   local `.env`, databases/images, backups, credentials, personal metadata,
   filesystem paths, raw reports, and browser artifacts. Retain intentional
   synthetic fixtures, screenshots, and reviewed synthetic benchmark evidence.
   Inspect newly added fixtures for synthetic content and documentation links
   for valid targets. Add no unrelated performance or release automation work.
8. Require green hosted backend, frontend, smoke, and every HEIC codec-matrix
   job on the final merged commit. Earlier PR results and local success do not
   replace this gate. Resolve every release-critical blocker, then require a
   clean/current checkout again immediately before tagging.

## Fresh-clone rehearsal

Clone the intended merged release commit into a new directory. Follow README
Quick Start without copying environment files, dependencies, or user data. Run
`setup` then `doctor`; missing storage is expected. Start backend and frontend
in separate terminals using the documented root commands. Confirm `/health` and
OpenAPI report `0.2.0`, and visit empty List, Timeline, Map, Albums, Collections,
Review, Duplicates, and Trash. Core startup and empty views require no AI or
external service. Stop the backend, run `python scripts/dev.py doctor --archive`,
and require a healthy empty archive.

Import a small synthetic disposable photo folder with the documented recursive
dry run and actual import. Restart the backend and confirm unchanged source
bytes and exact/visual duplicate handling. Save a Favorite and Rating, correct
capture/GPS values, and exercise Clear or Restore original metadata. Check
supported Map/List navigation and explanations for unsupported criteria. If a
visual pair is available, Keep both and reload to check its persistence.
The automated first-run and browser tests supplement this pass; the clean clone
also checks prerequisite installation and the published user instructions.

Stop this disposable backend for a manual recovery pass. Create a backup in an
existing directory outside managed storage, verify it, and rehearse into a
nonexistent sibling target. Require `Archive doctor: HEALTHY` and
`Restore rehearsal: PASSED`; inspect preserved curation/provenance and unchanged
source bytes. Destination rules and commands are in
[Operations](OPERATIONS.md#backup-and-recovery). Never replace production storage
as a release test. Keep all rehearsal data independent of the real archive.

## Tag and publish manually

Only after every gate passes, the maintainer runs these commands from the clean
release commit on `master`:

```sh
git tag -a v0.2.0 -m "FaunaVault v0.2.0"
git show --no-patch v0.2.0
git push origin v0.2.0
```

In the [GitHub release form](https://github.com/JureZajc/faunavault/releases/new),
select the existing `v0.2.0` tag, set title **FaunaVault v0.2.0**, and copy the
prepared GitHub notes from the readiness report, based on the finalized
changelog. Review and publish manually. Use generated source downloads; attach
no checkout ZIP, environment, real archive, backup, raw benchmark output, or
private smoke artifact. Do not alter `v0.1.0`.

After publishing, confirm the annotated tag resolves to the validated commit
and the notes and source downloads are accessible. Record the release URL and
validation results. Installers, cloud sync, multi-user access, automatic updates,
semantic search, AI ranking, and automated production restore remain deferred.
