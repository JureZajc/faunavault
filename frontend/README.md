# FaunaVault frontend

The Next.js 16 App Router frontend provides the photo catalog, species albums,
metadata review, persistent local-AI job controls, and Trash workflows.
Project-wide setup, storage, backup, and backend behavior are documented in the
[root README](../README.md).

## Architecture

The catalog route in `app/page.tsx` remains the route-level orchestrator. Its
focused hooks own URL query state, paginated photo loading, lazy verified-taxon
options, classification-job polling, and upload state. Components under
`app/components/catalog/` own the toolbar, results, classification panel, upload
form, and per-file progress presentation. The List fetches one backend-filtered
page at a time, debounces search, and stores page, search, filters, sorting,
verified taxon, layout, and collection view in the URL. Category grouping is
intentionally limited to the current page.

The photo-detail route follows the same boundary: `photo-detail.tsx` coordinates
loading, classification, return navigation, and Trash completion, while hooks
and components under `app/components/photo-detail/` own photo media, metadata
editing, linked-animal/taxonomy presentation, classification controls, the
sidebar, and the Move to Trash confirmation. State remains in focused React
hooks and route clients; the frontend does not use a global state or
data-fetching library.

Durable classification state is restored from the backend after refresh. The
frontend polls only while queued or running work exists and keeps low-confidence
`needs_review` results distinct from failed job execution.

## Upload queue and duplicate review

The interactive uploader uses the single-photo API through a
frontend-controlled sequential queue; it does not send the selection through
the compatibility batch endpoint. Rows appear immediately as `Waiting`, then
truthfully transition through `Uploading`, `Uploaded`, `Exact duplicate`,
`Possible duplicate`, or `Failed` (`Cancelled` is the result of cancelling a
review). Progress is ordinal, not a fabricated byte percentage.

Each file keeps its own outcome, so a failure or duplicate does not stop later
files or undo completed uploads. Network and HTTP 5xx failures can be retried
individually while completed sibling rows remain unchanged. Catalog refreshes
are grouped after the initial pass and, when `Keep both` creates more photos,
after the review queue drains rather than after every file.

Exact byte duplicates retain their existing non-bypassable warning. Possible
visual duplicates open a keyboard-accessible review dialog with the local
upload and ID-based Catalog/Trash candidate previews. Each flagged item is
reviewed independently after the initial upload pass with `Keep both` or
`Cancel upload`; Keep both repeats that file's upload with explicit
authorization while the backend performs all checks again. A failed
confirmation leaves that review open, and remaining reviews and completed files
retain their state. Pending reviews live only in the current page and do not
survive refresh.

## Modal and lightbox accessibility

Duplicate review, Move to Trash, permanent deletion, photo-detail deletion, and
the shared image lightbox use the same modal-accessibility hook. It supplies
modal semantics, safe initial focus, a focus trap that follows currently enabled
controls, Escape handling that respects busy submissions, focus restoration,
and reference-counted body scroll locking. The shared lightbox adds keyboard
previous/next navigation, loading and error states, and accessible labels.

## Development

Set `NEXT_PUBLIC_API_URL` in `.env.local`; see `.env.local.example` for the local
default.

```powershell
npm ci
npm run dev
```

As an optional repository-root shortcut, run `python scripts/dev.py frontend`.

Run the complete frontend validation sequence from this directory:

```powershell
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

`npm test` runs the Vitest/JSDOM interaction suite.
