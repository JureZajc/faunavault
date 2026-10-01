"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getImportSession, ImportSession } from "../lib/api";
import { importCullHref, importDate, importListHref, importSourceLabel } from "../lib/import-sessions";

export function ImportSessionCard({ item }: { item: ImportSession }) {
  return <section aria-label="Import Session" className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
    <h2 className="break-words font-semibold text-stone-950">{importSourceLabel(item)}{item.label ? ` · ${item.label}` : ""}</h2>
    <p className="mt-1 text-sm text-stone-600">{importDate(item.started_at)} · {item.completed_at ? "Completed" : "Not finalized"}</p>
    <p className="mt-3 text-sm">{item.imported_count} imported originally · {item.active_count} active / {item.trash_count} in Trash</p>
    <p className="mt-1 text-sm text-stone-700">Active photos: {item.undecided_count} undecided · {item.pick_count} Pick · {item.reject_count} Reject</p>
    {item.completed_at ? <p className="mt-1 text-xs text-stone-500">Reported outcomes: {item.duplicate_count} exact duplicates · {item.visual_duplicate_skipped_count} visual duplicates skipped · {item.unsupported_count} unsupported · {item.failed_count} failed</p> : <p className="mt-1 text-xs text-stone-500">The operation has not finalized its outcome summary. Saved photos remain available.</p>}
    {item.active_count === 0 ? <p className="mt-2 text-sm text-stone-600">{item.imported_count === 0 ? "No photos have been imported in this session." : "No active photos remain in this import."}</p> : <div className="mt-3 flex flex-wrap gap-3">
      <Link href={importListHref(item.id)} className="inline-flex min-h-11 items-center rounded-md border border-emerald-700 px-3 text-sm font-semibold text-emerald-900">View imported photos</Link>
      <Link href={importCullHref(item.id)} className="inline-flex min-h-11 items-center rounded-md bg-emerald-800 px-3 text-sm font-semibold text-white">Cull this import</Link>
    </div>}
  </section>;
}

export default function ImportSessionSummary({ id, revision }: { id: string; revision?: unknown }) {
  const [item, setItem] = useState<ImportSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getImportSession(id, controller.signal).then((next) => { if (!controller.signal.aborted) { setItem(next); setError(null); } }).catch((failure) => { if (!controller.signal.aborted) { setItem(null); setError(failure instanceof Error ? failure.message : "Could not load Import Session"); } });
    return () => controller.abort();
  }, [id, revision, retry]);
  return <div className="mb-5 space-y-3">
    <Link href="/imports" className="text-sm font-semibold text-emerald-900 underline">Recent Imports</Link>
    {error ? <p role="alert">{error} <button type="button" className="underline" onClick={() => setRetry((value) => value + 1)}>Retry</button></p> : item?.id === id ? <ImportSessionCard item={item} /> : <p role="status">Loading Import Session…</p>}
  </div>;
}
