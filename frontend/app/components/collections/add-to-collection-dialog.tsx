"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { useCollections } from "../../hooks/use-collections";
import { addPhotosToCollection, CollectionAddPhotosResponse } from "../../lib/api";

export default function AddToCollectionDialog({ photoIds, onClose, onSuccess }: {
  photoIds: number[] | null;
  onClose: () => void;
  onSuccess: (response: CollectionAddPhotosResponse) => void;
}) {
  const { items, isLoading, error: loadError, load } = useCollections(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = () => { if (!isBusy) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen: photoIds !== null, dialogRef, initialFocusRef: cancelRef, onClose: close, isBusy });
  useEffect(() => {
    if (!photoIds) return;
    void load().catch(() => undefined);
  }, [load, photoIds]);
  if (!photoIds) return null;
  async function add() {
    if (selectedId === null || isBusy) return;
    setIsBusy(true); setError(null);
    try { onSuccess(await addPhotosToCollection(selectedId, { photo_ids: photoIds! })); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Could not add photos to the Collection"); }
    finally { setIsBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/40 p-3 sm:p-6">
    <div ref={dialogRef} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="add-collection-title" tabIndex={-1} className="my-auto max-h-[calc(100vh-1.5rem)] w-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
      <h2 id="add-collection-title" className="text-xl font-semibold">Add {photoIds.length} {photoIds.length === 1 ? "photo" : "photos"} to Collection</h2>
      <p className="mt-2 text-sm text-stone-600">Choose one existing Collection. Photos can belong to multiple Collections.</p>
      {isLoading ? <p className="mt-5 text-sm text-stone-500">Loading Collections…</p> : items.length ? <fieldset className="mt-4 max-h-72 space-y-2 overflow-y-auto"><legend className="sr-only">Target Collection</legend>{items.map((item) => <label key={item.id} className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md border border-stone-200 p-3"><span className="flex min-w-0 items-center gap-3"><input type="radio" name="collection" checked={selectedId === item.id} onChange={() => setSelectedId(item.id)} className="h-5 w-5 accent-emerald-800" /><span className="truncate font-medium">{item.name}</span></span><span className="shrink-0 text-xs text-stone-500">{item.active_photo_count} photos</span></label>)}</fieldset> : !loadError ? <p className="mt-5 rounded-md bg-stone-50 p-4 text-sm">No Collections exist yet. A Collection must be created before photos can be added. <Link href="/collections" className="font-semibold text-emerald-800 underline">Create a Collection first</Link>.</p> : null}
      {error || loadError ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error ?? loadError}</p> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><button ref={cancelRef} type="button" disabled={isBusy} onClick={close} className="min-h-11 rounded-md border bg-white font-semibold">Cancel</button><button type="button" disabled={isBusy || selectedId === null} onClick={() => void add()} className="min-h-11 rounded-md bg-emerald-800 font-semibold text-white disabled:opacity-50">{isBusy ? "Adding…" : "Add to Collection"}</button></div>
    </div>
  </div>;
}
