# Publishing FaunaVault v0.1.0

This release distributes source through GitHub's generated source archives.
There is no installer, bundled runtime, container distribution, or automatic
publishing workflow. Implementation and tests never create/push tags or releases.

## Validate the release commit

1. Review and merge the readiness changes into `master`. Stop local development
   servers, especially the frontend before installing dependencies on Windows.
2. On a clean checkout, run `git switch master`, `git pull --ff-only`, and
   `git status --porcelain`. Require no pending changes and ensure the intended
   commit is current on `origin/master`. Do not tag a dirty checkout or unrelated
   commit.
3. Confirm `backend/pyproject.toml` has `project.version = "0.1.0"`. It is the
   application version authority; frontend package metadata has no separate
   release version. `/health`, OpenAPI, and newly created backup manifests use
   the shared reader. Schema 13 and backup format v1 are independently versioned.
4. Install locked dependencies with `python scripts/dev.py setup`, then run:

   ```sh
   python scripts/dev.py doctor
   python scripts/dev.py check
   cd frontend
   npx playwright install chromium
   npm run test:e2e
   cd ..
   ```

   `check` includes first-run/migration and backup verification/rehearsal tests
   plus frontend production build. Browser smoke builds separately because it
   uses the dedicated test API URL. Require successful exits and review reported
   platform skips/warnings. CI backend, frontend, smoke, and codec jobs must pass.
   `check-clean` may replace the installation-plus-check sequence when an existing
   checkout needs dependency replacement.
5. Perform the fresh-clone rehearsal below. Confirm that it works without
   Ollama and never uses the maintainer's live data.
6. Confirm backup-v1 schemas 9–13 remain supported and compatibility tests pass:

   ```sh
   cd backend
   uv run --no-sync pytest tests/test_first_run.py tests/test_backup.py tests/test_restore_rehearsal.py
   cd ..
   ```

   This focused command is useful during diagnosis; the full check already runs
   these tests, so it need not be repeated when that result is current. Coverage
   includes backup creation/verification, genuine intermediate schemas, isolated
   migration/rehearsal, healthy doctor, metadata/media preservation, and refusal
   before target writes for invalid backups. Never rebuild the frozen schema-9
   fixture or weaken the verifier to obtain a green result.
7. Review the `0.1.0` entry in `CHANGELOG.md`, README limitations, MIT license,
   and HEIC fixture's BSD notice. Inspect the tracked-file list before publication:
   no local `.env`, user database/images, backups, source-photo paths, credentials,
   or machine-specific reports. Generated GitHub source archives contain tracked
   files only; retain the intentional synthetic test fixtures and screenshots.

## Fresh-clone rehearsal

Clone the intended release commit into a new directory. Follow README Quick
Start with no copied `.env` or user data. Run `setup` then `doctor`; missing storage
is expected. Start backend/frontend in separate terminals, open the empty catalog,
and verify `/health` reports version 0.1.0. Stop the backend and run
`python scripts/dev.py doctor --archive`; require a healthy empty archive.

Optionally import a small disposable photo set using a recursive dry run and
actual import, then restart and confirm original/source safety and duplicate
handling. Keep this storage independent of the real archive. No AI setup is
required. The automated first-run test and browser smoke cover the same storage
startup path in temporary locations; this manual pass verifies the user-facing
instructions and prerequisite installation too.

For a manual recovery pass, stop this disposable backend, create a backup in an
existing directory outside its managed storage, verify it, and rehearse into a
nonexistent sibling target. Require `Archive doctor: HEALTHY` and
`Restore rehearsal: PASSED`. Commands and destination rules are in
[Operations](OPERATIONS.md#backup-and-recovery). Do not perform a production
restore as a release test.

## Tag and publish manually

Only after all gates pass, from the clean release commit on `master`:

```sh
git tag -a v0.1.0 -m "FaunaVault v0.1.0"
git show --no-patch v0.1.0
git push origin v0.1.0
```

In the [GitHub release form](https://github.com/JureZajc/faunavault/releases/new),
select the existing `v0.1.0` tag, set title **FaunaVault v0.1.0**, and copy only the
0.1.0 changelog entry as the release notes. Review then publish manually. Use
GitHub's generated source downloads; attach no checkout ZIP, local environment,
real archive, backup, benchmark output, or private smoke artifact.

After publishing, confirm the tag resolves to the validated commit and that the
release notes and source downloads are accessible. Record the release URL and
validation results. Installer/distribution, authentication, cloud sync, automatic
updates, FTS/search redesign, and broader performance work remain deferred.
