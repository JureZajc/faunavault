"use client";

import { FormEvent, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { CollectionSummary } from "../../lib/api";

export default function CollectionNameDialog({ mode, initialName = "", isOpen, onClose, onSave }: {
  mode: "create" | "rename";
  initialName?: string;
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string) => Promise<CollectionSummary>;
}) {
  const [name, setName] = useState(initialName);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => { if (!isBusy) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen, dialogRef, initialFocusRef: inputRef, onClose: close, isBusy });
  if (!isOpen) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (isBusy) return;
    if (!name.trim()) { setError("Collection name must not be empty."); return; }
    setIsBusy(true);
    setError(null);
    try {
      await onSave(name);
      onClose();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not save the Collection");
    } finally {
      setIsBusy(false);
    }
  }

  const title = mode === "create" ? "Create Collection" : "Rename Collection";
  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/40 p-3 sm:p-6">
    <form ref={dialogRef} onSubmit={submit} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="collection-name-title" className="my-auto w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
      <h2 id="collection-name-title" className="text-xl font-semibold">{title}</h2>
      <label className="mt-4 block text-sm font-medium text-stone-700">Collection name
        <input ref={inputRef} value={name} disabled={isBusy} onChange={(event) => setName(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
      </label>
      {error ? <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button type="button" disabled={isBusy} onClick={close} className="min-h-11 rounded-md border bg-white font-semibold">Cancel</button>
        <button type="submit" disabled={isBusy} className="min-h-11 rounded-md bg-emerald-800 font-semibold text-white disabled:opacity-50">{isBusy ? "Saving…" : title}</button>
      </div>
    </form>
  </div>;
}
