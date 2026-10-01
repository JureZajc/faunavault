"use client";
import { useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";

export default function EventConfirmDialog({ title, description, action, onClose, onConfirm }: { title: string; description: string; action: string; onClose: () => void; onConfirm: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const saving = useRef(false), root = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const close = () => { if (!saving.current) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef: root, initialFocusRef: cancel, onClose: close, isBusy: busy });
  async function confirm() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await onConfirm(); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not complete operation."); }
    finally { saving.current = false; setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-3"><div ref={root} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="event-confirm-title" className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"><h2 id="event-confirm-title" className="break-words text-xl font-semibold">{title}</h2><p className="mt-3 text-sm text-stone-600">{description}</p>{error ? <p role="alert" className="mt-3 text-red-700">{error}</p> : null}<div className="mt-5 flex gap-3"><button ref={cancel} disabled={busy} onClick={close} className="min-h-11 flex-1 rounded-md border px-3 font-semibold">Cancel</button><button disabled={busy} onClick={() => void confirm()} className="min-h-11 flex-1 rounded-md bg-red-700 px-3 font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : action}</button></div></div></div>;
}
