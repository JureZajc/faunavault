"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import { getMetadataHealth, MetadataHealth, MetadataIssue } from "../lib/api";
import { catalogListHref, DEFAULT_CATALOG_STATE, metadataIssueLabels } from "../lib/catalog-query";

const listHref = (issue?: MetadataIssue) => catalogListHref({ ...DEFAULT_CATALOG_STATE, metadata_issue: issue });
const count = (value: number) => new Intl.NumberFormat("en").format(value);

export default function MetadataHealthPage() {
  const [data, setData] = useState<MetadataHealth | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(false);
    try {
      const result = await getMetadataHealth(request.signal);
      if (!request.signal.aborted) setData(result);
    } catch {
      if (!request.signal.aborted) setError(true);
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [load]);

  return <main className="min-h-screen min-w-0 bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <ArchiveNavigation active="metadata-health" />
      <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
        <h1 className="text-3xl font-semibold tracking-tight">Metadata Health</h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-stone-600">Find and correct missing capture dates and GPS coordinates using the existing Photo editor and bulk editing tools. Only active Photos count; Trash is excluded.</p>
      </header>
      {loading ? <p role="status" className="py-8">Loading Metadata Health…</p> : error ? <div role="alert" className="my-6 rounded-xl border border-red-200 bg-red-50 p-5 text-red-800">
        <p>Could not load Metadata Health.</p><button type="button" onClick={() => void load()} className="mt-3 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-semibold">Retry</button>
      </div> : data && <>
        <section aria-labelledby="metadata-completeness" className="my-5 rounded-xl border border-stone-200 bg-white p-5">
          <h2 id="metadata-completeness" className="text-lg font-semibold">Overall metadata completeness</h2>
          <Link href={listHref("complete")} className="mt-3 inline-flex min-h-11 items-center text-4xl font-semibold text-emerald-950 underline decoration-emerald-200 underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-700" aria-label={`Browse complete Photos: ${data.completeness_percentage}%`}>{data.completeness_percentage}%</Link>
          <progress aria-label="Metadata completeness" max={100} value={data.completeness_percentage} className="mt-4 block h-3 w-full accent-emerald-700" />
          <p className="mt-3 text-sm leading-6 text-stone-600">Complete means a capture date and both GPS coordinates within valid ranges. (0,0) is valid. Import timestamps are never substituted for capture dates. Camera, lens, tags, taxonomy and classification do not affect this percentage.</p>
        </section>
        <dl aria-label="Metadata health counts" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[{ key: "active_total" as const, label: "Total active Photos", issue: undefined }, ...Object.entries(metadataIssueLabels).map(([key, label]) => ({ key: key as MetadataIssue, label, issue: key as MetadataIssue }))].map(({ key, label, issue }) => <div key={key} className="min-w-0 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <dt><Link href={listHref(issue)} className="inline-flex min-h-11 items-center text-sm font-semibold text-emerald-900 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-emerald-700">{label}</Link></dt>
            <dd className="mt-2 text-3xl font-semibold tabular-nums text-emerald-950">{count(data[key])}</dd>
          </div>)}
        </dl>
        {data.active_total === 0 && <p role="status" className="mt-5 rounded-xl border border-dashed border-stone-300 bg-white p-6">No active Photos yet. Import Photos from List to start checking metadata.</p>}
      </>}
      <section aria-labelledby="cleanup-workflow" className="mt-6 rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
        <h2 id="cleanup-workflow" className="text-xl font-semibold">Correct missing metadata</h2>
        <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-stone-700">
          <li>Open a filtered List above, then open a Photo and choose <strong>Edit metadata</strong>.</li>
          <li>Enter its capture date or GPS coordinates. Use <strong>Choose on map</strong> in the existing GPS picker if helpful, then Save.</li>
          <li>Return to the filtered List. Corrected Photos disappear when they no longer match the missing metadata filter.</li>
        </ol>
        <p className="mt-4 text-sm leading-6 text-stone-700">For bulk GPS editing, open <Link href={listHref("missing_gps")} className="font-semibold underline">Missing GPS Photos</Link>, choose Select photos, then Edit capture / GPS and Set GPS. Choose coordinates, preview the changes, review and confirm. Use the same bulk editor to explicitly set or shift capture dates; confirm a shared date only when it is correct for every selected Photo.</p>
        <h3 className="mt-5 font-semibold">Restore original extracted metadata</h3>
        <p className="mt-2 text-sm leading-6 text-stone-700">For manually edited or deliberately cleared metadata, an original value may be available. Open Edit metadata and choose Restore original metadata, or preview Restore original in the bulk editor. Restoration verifies and re-reads the original file before saving. Review carefully: it replaces the selected manual overrides. Nothing is restored automatically, and original image files are never modified.</p>
        <p className="mt-4 text-sm leading-6 text-stone-500">Metadata completeness filters stay in the List URL for reload and Back/Forward. Map and version-1 Smart Collections do not support these filters; clear them explicitly before switching or saving.</p>
      </section>
    </div>
  </main>;
}
