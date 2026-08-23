"use client";

import { useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { removePhotosFromCollection } from "../../lib/api";

export default function RemoveFromCollectionDialog({ collectionId, collectionName, photoIds, onClose, onSuccess }: {
  collectionId: number;
  collectionName: string;
  photoIds: number[] | null;
  onClose: () => void;
  onSuccess: (removedCount: number) => void;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = () => { if (!isBusy) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen: photoIds !== null, dialogRef, initialFocusRef: cancelRef, onClose: close, isBusy });
  if (!photoIds) return null;
  async function remove() {
    if (isBusy) return;
    setIsBusy(true); setError(null);
    try {
      const result = await removePhotosFromCollection(collectionId, { photo_ids: photoIds! });
      onSuccess(result.removed_count);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not remove photos from the Collection");
    } finally { setIsBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-3 sm:p-6">
    <div ref={dialogRef} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="remove-collection-title" tabIndex={-1} className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
      <h2 id="remove-collection-title" className="text-xl font-semibold">Remove {photoIds.length} {photoIds.length === 1 ? "photo" : "photos"} from “{collectionName}”?</h2>
      <p className="mt-3 text-sm leading-6 text-stone-600">This removes Collection membership only. The photos stay in FaunaVault, keep their metadata and files, and remain in other Collections.</p>
      {error ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2"><button ref={cancelRef} type="button" disabled={isBusy} onClick={close} className="min-h-11 rounded-md border bg-white font-semibold">Cancel</button><button type="button" disabled={isBusy} onClick={() => void remove()} className="min-h-11 rounded-md bg-amber-700 font-semibold text-white disabled:opacity-50">{isBusy ? "Removing…" : "Remove from Collection"}</button></div>
    </div>
  </div>;
}
