"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ArchiveNavigation from "../components/archive-navigation";
import { ImportSessionCard } from "../components/import-session-summary";
import { getImportSessions } from "../lib/api";

export default function ImportsBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const value = params.get("page");
  const page = value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 1;
  const [data, setData] = useState<Awaited<ReturnType<typeof getImportSessions>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getImportSessions(page, controller.signal).then((next) => { if (!controller.signal.aborted) { setData(next); setError(null); } }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load Recent Imports"); });
    return () => controller.abort();
  }, [page, retry]);
  return <main className="mx-auto max-w-7xl px-4 py-8">
    <ArchiveNavigation active="list" />
    <h1 className="mt-6 text-3xl font-semibold text-stone-950">Recent Imports</h1>
    <p className="mt-2 text-sm text-stone-600">Photos brought in together by one upload selection or folder import. Historical photos may have no Import Session.</p>
    {error ? <p role="alert" className="mt-6">{error} <button className="underline" onClick={() => setRetry((number) => number + 1)}>Retry</button></p> : !data || data.page !== page ? <p role="status" className="mt-6">Loading Recent Imports…</p> : <>
      {data.items.length ? <div className="mt-6 grid gap-4 md:grid-cols-2">{data.items.map((item) => <ImportSessionCard key={item.id} item={item} />)}</div> : <p className="mt-6">No Import Sessions on this page. New imports will appear here.</p>}
      <nav aria-label="Import history pages" className="mt-6 flex items-center gap-4"><button disabled={page === 1} onClick={() => router.push(page === 2 ? "/imports" : `/imports?page=${page - 1}`)} className="min-h-11 rounded-md border px-4 disabled:opacity-50">Previous</button><span>Page {page} of {Math.max(1, data.total_pages)}</span><button disabled={page >= data.total_pages} onClick={() => router.push(`/imports?page=${page + 1}`)} className="min-h-11 rounded-md border px-4 disabled:opacity-50">Next</button></nav>
    </>}
  </main>;
}
