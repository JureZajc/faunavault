# FaunaVault frontend

The Next.js 16 frontend provides the photo catalog, species albums, metadata review, persistent local-AI job controls, and Trash workflows. The main List fetches one backend-filtered page at a time, stores its query in the URL, debounces search, and lazily loads bounded verified-taxon options. Category grouping applies to the current page. Classification state is restored from the backend after refresh and polled only while queued/running work exists.

Exact byte duplicates retain their existing non-bypassable warning. Possible
visual duplicates open a keyboard-accessible review dialog with the local upload
and ID-based Catalog/Trash candidate previews. Each flagged batch item is
reviewed independently with `Keep both` or `Cancel upload`; Keep both repeats the
upload with explicit authorization while the backend performs all checks again.
Pending reviews live only in the current page and do not survive refresh.

```powershell
npm ci
npm run dev
```

Set `NEXT_PUBLIC_API_URL` in `.env.local`. Validation commands are `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Project-wide setup and storage documentation live in the root README.
