"use client";

import { useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { CollectionSummary } from "../../lib/api";

export default function DeleteCollectionDialog({ collection, onClose, onDelete }: {
  collection: CollectionSummary | null;
  onClose: () => void;
  onDelete: () => Promise<void>;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = () => { if (!isBusy) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen: collection !== null, dialogRef, initialFocusRef: cancelRef, onClose: close, isBusy });
  if (!collection) return null;
  async function remove() {
    if (isBusy) return;
    setIsBusy(true); setError(null);
    try { await onDelete(); onClose(); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Could not delete the Collection"); }
    finally { setIsBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-3 sm:p-6">
    <div ref={dialogRef} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="delete-collection-title" aria-describedby="delete-collection-description" tabIndex={-1} className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
      <h2 id="delete-collection-title" className="text-xl font-semibold">Delete collection “{collection.name}”?</h2>
      <p id="delete-collection-description" className="mt-3 text-sm leading-6 text-stone-600">Photos in this collection—including any currently in Trash—stay in FaunaVault. Photo files are not deleted.</p>
      {error ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button ref={cancelRef} type="button" disabled={isBusy} onClick={close} className="min-h-11 rounded-md border bg-white font-semibold">Cancel</button>
        <button type="button" disabled={isBusy} onClick={() => void remove()} className="min-h-11 rounded-md bg-red-700 font-semibold text-white disabled:opacity-50">{isBusy ? "Deleting…" : "Delete Collection"}</button>
      </div>
    </div>
  </div>;
}
