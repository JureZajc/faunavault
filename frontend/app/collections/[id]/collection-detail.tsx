"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import ArchiveNavigation from "../../components/archive-navigation";
import CollectionNameDialog from "../../components/collections/collection-name-dialog";
import CollectionSelectionToolbar from "../../components/collections/collection-selection-toolbar";
import DeleteCollectionDialog from "../../components/collections/delete-collection-dialog";
import RemoveFromCollectionDialog from "../../components/collections/remove-from-collection-dialog";
import PhotoCard from "../../components/catalog/photo-card";
import { useCatalogSelection } from "../../hooks/use-catalog-selection";
import { useCollectionDetail } from "../../hooks/use-collection-detail";
import { deleteCollection, renameCollection } from "../../lib/api";

function positivePage(value: string | null) {
  return value && /^\d+$/.test(value) && Number(value) > 0 ? Number(value) : 1;
}

export default function CollectionDetailView({ collectionId }: { collectionId: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = positivePage(searchParams.get("page"));
  const navigatePage = useCallback((nextPage: number, replace = false) => {
    const href = nextPage > 1 ? `/collections/${collectionId}?page=${nextPage}` : `/collections/${collectionId}`;
    if (replace) router.replace(href, { scroll: false }); else router.push(href, { scroll: false });
  }, [collectionId, router]);
  const correctPage = useCallback((nextPage: number) => navigatePage(nextPage, true), [navigatePage]);
  const detail = useCollectionDetail(collectionId, page, correctPage);
  const selection = useCatalogSelection(`collection:${collectionId}`);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removeIds, setRemoveIds] = useState<number[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const photos = useMemo(() => detail.data?.photos.items ?? [], [detail.data?.photos.items]);
  const visibleIds = useMemo(() => photos.map((photo) => photo.id), [photos]);

  if (detail.isLoading && !detail.data) return <main className="min-h-screen bg-[#f7f8f4] p-8"><div className="mx-auto h-96 max-w-7xl animate-pulse rounded-xl bg-white" /></main>;
  if (detail.error || !detail.data) return <main className="min-h-screen bg-[#f7f8f4] p-8"><div className="mx-auto max-w-3xl rounded-xl border border-red-200 bg-red-50 p-5 text-red-700"><h1 className="text-xl font-semibold">Collection unavailable</h1><p className="mt-2">{detail.error ?? "Collection not found"}</p><button type="button" onClick={() => void detail.refresh()} className="mt-3 font-semibold underline">Retry</button></div></main>;
  const collection = detail.data;
  const returnTo = page > 1 ? `/collections/${collectionId}?page=${page}` : `/collections/${collectionId}`;

  async function removed(count: number) {
    setRemoveIds(null);
    selection.reset();
    setNotice(`Removed ${count} ${count === 1 ? "photo" : "photos"} from the Collection. The photos remain in FaunaVault.`);
    await detail.refresh();
  }

  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><ArchiveNavigation active="collections" /><p className="text-sm text-stone-500">Manual Collection</p></div>
      {notice ? <p role="status" className="mt-5 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p> : null}
      <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Collection</p><h1 className="mt-2 break-words text-3xl font-semibold">{collection.name}</h1><p className="mt-2 text-sm text-stone-500">{collection.active_photo_count} active {collection.active_photo_count === 1 ? "photo" : "photos"}</p></div><div className="grid grid-cols-2 gap-2 sm:flex"><button type="button" onClick={() => setRenameOpen(true)} className="min-h-11 rounded-md border bg-white px-4 text-sm font-semibold">Rename</button><button type="button" onClick={() => setDeleteOpen(true)} className="min-h-11 rounded-md border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700">Delete Collection</button></div></div>
        {!selection.isSelecting ? <button type="button" onClick={selection.enter} disabled={!collection.active_photo_count} className="mt-5 min-h-11 rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900 disabled:opacity-50">Select photos</button> : null}
      </header>
      {selection.isSelecting ? <CollectionSelectionToolbar selectedIds={selection.selectedIds} visibleIds={visibleIds} error={selection.error} onTogglePage={selection.togglePage} onClear={selection.clear} onExit={selection.reset} onRemove={() => setRemoveIds(Array.from(selection.selectedIds).sort((a, b) => a - b))} /> : null}
      {photos.length ? <div className="grid items-stretch gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{photos.map((photo) => <PhotoCard key={photo.id} photo={photo} returnTo={returnTo} isSelectionMode={selection.isSelecting} isSelected={selection.selectedIds.has(photo.id)} onToggleSelection={selection.toggle} action={<button type="button" onClick={() => setRemoveIds([photo.id])} className="min-h-10 w-full rounded-md border border-amber-200 bg-amber-50 px-3 text-xs font-semibold text-amber-800">Remove from Collection</button>} />)}</div> : <div className="my-8 rounded-xl border border-dashed border-stone-300 bg-white px-4 py-14 text-center"><h2 className="text-xl font-semibold">No photos in this collection yet.</h2><p className="mt-2 text-sm text-stone-500">Select active photos in List and use Add to Collection.</p></div>}
      {collection.photos.total_pages > 1 ? <nav aria-label="Collection pagination" className="flex flex-wrap items-center justify-center gap-3 pb-10"><button type="button" disabled={page === 1 || detail.isLoading} onClick={() => navigatePage(page - 1)} className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-40">Previous</button><span className="text-sm text-stone-600">Page {page} of {collection.photos.total_pages}</span><button type="button" disabled={page >= collection.photos.total_pages || detail.isLoading} onClick={() => navigatePage(page + 1)} className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-40">Next</button></nav> : null}
    </div>
    <CollectionNameDialog key={`collection-rename-${renameOpen ? collection.updated_at : "closed"}`} mode="rename" initialName={collection.name} isOpen={renameOpen} onClose={() => setRenameOpen(false)} onSave={async (name) => { const saved = await renameCollection(collectionId, { name }); detail.setData((current) => current ? { ...current, ...saved } : current); setNotice(`Renamed Collection to “${saved.name}”.`); return saved; }} />
    <DeleteCollectionDialog key={`collection-delete-${deleteOpen ? collectionId : "closed"}`} collection={deleteOpen ? collection : null} onClose={() => setDeleteOpen(false)} onDelete={async () => { await deleteCollection(collectionId); router.push("/collections"); }} />
    <RemoveFromCollectionDialog key={`collection-remove-${removeIds?.join("-") ?? "closed"}`} collectionId={collectionId} collectionName={collection.name} photoIds={removeIds} onClose={() => setRemoveIds(null)} onSuccess={(count) => void removed(count)} />
  </main>;
}
