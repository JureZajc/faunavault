"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ArchiveNavigation from "../../../components/archive-navigation";
import PhotoCard from "../../../components/catalog/photo-card";
import CollectionNameDialog from "../../../components/collections/collection-name-dialog";
import DeleteCollectionDialog from "../../../components/collections/delete-collection-dialog";
import MoveToTrashButton from "../../../components/move-to-trash-button";
import {
  CatalogPhotoPage, deleteSmartCollection, getSmartCollection,
  getSmartCollectionPhotos, SmartCollection, updateSmartCollection,
} from "../../../lib/api";
import { smartCollectionCriteria, smartCollectionEditHref } from "../../../lib/smart-collections";

function readPage(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export default function SmartCollectionDetail({ collectionId }: { collectionId: number }) {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const params = useSearchParams();
  const page = readPage(params.get("page"));
  const [collection, setCollection] = useState<SmartCollection | null>(null);
  const [photos, setPhotos] = useState<CatalogPhotoPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [resultsLoading, setResultsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resultsError, setResultsError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCollection = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setCollection(null);
    setPhotos(null);
    setResultsLoading(true);
    try { setCollection(await getSmartCollection(collectionId, signal)); }
    catch (nextError) { if (!signal?.aborted) setError(nextError instanceof Error ? nextError.message : "Could not load Smart Collection"); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [collectionId]);

  const loadPhotos = useCallback(async (signal?: AbortSignal) => {
    setResultsLoading(true);
    setResultsError(null);
    try {
      const result = await getSmartCollectionPhotos(collectionId, page, signal);
      if (signal?.aborted) return;
      if (page > Math.max(result.total_pages, 1)) {
        const corrected = Math.max(result.total_pages, 1);
        routerRef.current.replace(corrected > 1 ? `/collections/smart/${collectionId}?page=${corrected}` : `/collections/smart/${collectionId}`, { scroll: false });
        return;
      }
      setPhotos(result);
    } catch (nextError) { if (!signal?.aborted) setResultsError(nextError instanceof Error ? nextError.message : "Could not load matching photos"); }
    finally { if (!signal?.aborted) setResultsLoading(false); }
  }, [collectionId, page]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadCollection(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [loadCollection]);

  useEffect(() => {
    if (!collection?.query_valid) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadPhotos(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [collection?.query_valid, loadPhotos]);

  function navigatePage(next: number) {
    router.push(next > 1 ? `/collections/smart/${collectionId}?page=${next}` : `/collections/smart/${collectionId}`, { scroll: false });
  }

  if (loading && !collection) return <main className="min-h-screen bg-[#f7f8f4] p-8"><div className="mx-auto h-96 max-w-7xl animate-pulse rounded-xl bg-white" /></main>;
  if (!collection) return <main className="min-h-screen bg-[#f7f8f4] p-8"><div role="alert" className="mx-auto max-w-3xl rounded-xl border border-red-200 bg-red-50 p-5 text-red-700"><h1 className="text-xl font-semibold">Smart Collection unavailable</h1><p className="mt-2">{error ?? "Smart Collection not found"}</p><button type="button" onClick={() => void loadCollection()} className="mt-3 font-semibold underline">Retry</button> <Link href="/collections" className="ml-3 underline">Collections</Link></div></main>;

  const returnTo = page > 1 ? `/collections/smart/${collectionId}?page=${page}` : `/collections/smart/${collectionId}`;
  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950"><div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
    <ArchiveNavigation active="collections" />
    {notice ? <p role="status" className="mt-5 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p> : null}
    <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">Smart Collection</p><h1 className="mt-2 break-words text-3xl font-semibold">{collection.name}</h1><p className="mt-2 text-sm text-stone-600">{collection.query ? smartCollectionCriteria(collection.query) : collection.query_error}</p>{collection.query_valid ? <p className="mt-3 text-sm text-stone-500">{photos ? `${photos.total} matching ${photos.total === 1 ? "photo" : "photos"}` : resultsError ? "Matching count unavailable" : "Loading matching photo count…"}</p> : null}</div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setRenameOpen(true)} className="min-h-11 rounded-md border px-4 text-sm font-semibold">Rename</button><Link href={smartCollectionEditHref(collectionId, collection.query)} className="min-h-11 rounded-md border px-4 py-3 text-sm font-semibold">{collection.query_valid ? "Edit criteria" : "Replace criteria"}</Link><button type="button" onClick={() => setDeleteOpen(true)} className="min-h-11 rounded-md border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700">Delete Smart Collection</button></div></div></header>
    {!collection.query_valid ? <p role="alert" className="mt-6 rounded-md bg-amber-50 p-4 text-sm text-amber-900">{collection.query_error}</p> : resultsError ? <div role="alert" className="mt-6 rounded-md bg-red-50 p-4 text-sm text-red-700">{resultsError} <button type="button" onClick={() => void loadPhotos()} className="font-semibold underline">Retry</button></div> : resultsLoading && !photos ? <div className="mt-8 h-80 animate-pulse rounded-xl bg-white" /> : photos?.items.length ? <div className="grid items-stretch gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{photos.items.map((photo) => <PhotoCard key={photo.id} photo={photo} returnTo={returnTo} action={<MoveToTrashButton photo={photo} onMoved={() => void loadPhotos()} onError={setResultsError} className="min-h-10 w-full rounded-md border px-3 text-xs font-semibold" />} />)}</div> : <div className="my-8 rounded-xl border border-dashed border-stone-300 bg-white p-12 text-center"><h2 className="text-xl font-semibold">No matching photos</h2><p className="mt-2 text-sm text-stone-600">Photos will appear here when their current metadata matches these saved criteria.</p></div>}
    {photos && photos.total_pages > 1 ? <nav aria-label="Smart Collection pagination" className="flex items-center justify-center gap-3 pb-10"><button type="button" disabled={page === 1 || resultsLoading} onClick={() => navigatePage(page - 1)} className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-40">Previous</button><span className="text-sm">Page {page} of {photos.total_pages}</span><button type="button" disabled={page >= photos.total_pages || resultsLoading} onClick={() => navigatePage(page + 1)} className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-40">Next</button></nav> : null}
  </div>
  <CollectionNameDialog key={`smart-detail-rename-${renameOpen ? collection.updated_at : "closed"}`} kind="Smart Collection" mode="rename" initialName={collection.name} isOpen={renameOpen} onClose={() => setRenameOpen(false)} onSave={async (name) => { const saved = await updateSmartCollection(collectionId, { name }); setCollection(saved); setNotice(`Renamed Smart Collection to “${saved.name}”.`); return saved; }} />
  <DeleteCollectionDialog key={`smart-detail-delete-${deleteOpen ? collectionId : "closed"}`} kind="Smart Collection" collection={deleteOpen ? collection : null} onClose={() => setDeleteOpen(false)} onDelete={async () => { await deleteSmartCollection(collectionId); router.push("/collections"); }} />
  </main>;
}
