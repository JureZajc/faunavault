"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import CollectionNameDialog from "../components/collections/collection-name-dialog";
import DeleteCollectionDialog from "../components/collections/delete-collection-dialog";
import {
  deleteSmartCollection,
  getSmartCollections,
  SmartCollectionSummary,
  updateSmartCollection,
} from "../lib/api";

export default function SmartCollectionsSection() {
  const [items, setItems] = useState<SmartCollectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SmartCollectionSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SmartCollectionSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getSmartCollections(signal);
      if (!signal?.aborted) setItems(result);
    } catch (nextError) {
      if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : "Could not load Smart Collections");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);

  return <section aria-labelledby="smart-collections-heading" className="pb-10">
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-stone-200 pb-3">
      <div><h2 id="smart-collections-heading" className="text-2xl font-semibold">Smart Collections</h2><p className="mt-1 text-sm text-stone-600">Saved searches that update as photos change.</p></div>
      <Link href="/" className="min-h-11 rounded-md border border-emerald-700 bg-white px-4 py-3 text-sm font-semibold text-emerald-900">Create from List</Link>
    </div>
    {notice ? <p role="status" className="mt-4 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p> : null}
    {error ? <div role="alert" className="mt-5 rounded-md bg-red-50 p-4 text-sm text-red-700">{error} <button type="button" onClick={() => void load()} className="font-semibold underline">Retry</button></div> : null}
    {loading ? <div className="mt-5 h-36 animate-pulse rounded-xl bg-white" /> : !error && !items.length ? <div className="mt-5 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center"><h3 className="text-lg font-semibold">No Smart Collections yet</h3><p className="mt-2 text-sm text-stone-600">Set filters in List, then save them as a Smart Collection.</p></div> : null}
    {!loading && !error && items.length ? <div className="grid gap-5 py-6 sm:grid-cols-2 lg:grid-cols-3">{items.map((item) => <article key={item.id} className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <Link href={`/collections/smart/${item.id}`} className="block"><span className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Smart Collection</span><h3 className="mt-2 break-words text-xl font-semibold hover:text-emerald-800">{item.name}</h3><p className="mt-3 text-sm text-stone-500">{item.query_valid ? "Live saved search" : item.query_error}</p></Link>
      <div className="mt-5 grid grid-cols-2 gap-2 border-t border-stone-100 pt-4"><button type="button" onClick={() => setRenameTarget(item)} className="min-h-11 rounded-md border bg-white text-sm font-semibold">Rename</button><button type="button" onClick={() => setDeleteTarget(item)} className="min-h-11 rounded-md border border-red-200 bg-red-50 text-sm font-semibold text-red-700">Delete Smart Collection</button></div>
    </article>)}</div> : null}
    <CollectionNameDialog key={`smart-rename-${renameTarget?.id ?? "closed"}`} kind="Smart Collection" mode="rename" initialName={renameTarget?.name ?? ""} isOpen={renameTarget !== null} onClose={() => setRenameTarget(null)} onSave={async (name) => {
      const saved = await updateSmartCollection(renameTarget!.id, { name });
      setItems((current) => current.map((item) => item.id === saved.id ? saved : item).sort((a, b) => a.name.localeCompare(b.name)));
      setNotice(`Renamed Smart Collection to “${saved.name}”.`);
      return saved;
    }} />
    <DeleteCollectionDialog key={`smart-delete-${deleteTarget?.id ?? "closed"}`} kind="Smart Collection" collection={deleteTarget} onClose={() => setDeleteTarget(null)} onDelete={async () => {
      await deleteSmartCollection(deleteTarget!.id);
      setItems((current) => current.filter((item) => item.id !== deleteTarget!.id));
      setNotice(`Deleted Smart Collection “${deleteTarget!.name}”. Photos remain in FaunaVault.`);
    }} />
  </section>;
}
