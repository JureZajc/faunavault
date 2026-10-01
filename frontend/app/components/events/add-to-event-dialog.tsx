"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { addEventPhotos, ArchiveEventPage, EventAddResponse, getEvents } from "../../lib/api";
import { eventDateLabel, eventKindLabel } from "../../lib/events";

export default function AddToEventDialog({ photoIds, onClose, onSuccess }: { photoIds: number[]; onClose: () => void; onSuccess: (response: EventAddResponse) => void }) {
  const [page, setPage] = useState(1), [data, setData] = useState<ArchiveEventPage | null>(null), [selected, setSelected] = useState<number | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const saving = useRef(false), root = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const close = () => { if (!saving.current) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef: root, initialFocusRef: cancel, onClose: close, isBusy: busy });
  useEffect(() => {
    const controller = new AbortController();
    getEvents(page, undefined, controller.signal).then((result) => { if (!controller.signal.aborted) { setData(result); setError(null); } }).catch((failure) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load Trips & Events."); });
    return () => controller.abort();
  }, [page, retry]);
  async function add() {
    if (saving.current || selected === null || data?.page !== page) return;
    saving.current = true; setBusy(true); setError(null);
    try { onSuccess(await addEventPhotos(selected, photoIds)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not add Photos."); }
    finally { saving.current = false; setBusy(false); }
  }
  const ready = data?.page === page;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-3"><div ref={root} role="dialog" aria-modal="true" aria-labelledby="add-event-title" onKeyDown={handleKeyDown} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl"><h2 id="add-event-title" className="text-xl font-semibold">Add {photoIds.length} Photos to Trip/Event</h2><p className="mt-2 text-sm text-stone-600">Choose an existing Trip or Event. Photos can belong to several experiences.</p>
    {ready && data.items.length ? <fieldset disabled={busy} className="mt-4 max-h-72 space-y-2 overflow-y-auto"><legend className="sr-only">Target Trip/Event</legend>{data.items.map((item) => <label key={item.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3"><input type="radio" name="target-event" checked={selected === item.id} onChange={() => setSelected(item.id)} className="mt-1 h-5 w-5 accent-emerald-800" /><span className="min-w-0"><span className="block break-words font-semibold">{item.title}</span><span className="block text-sm text-stone-600">{eventKindLabel(item.kind)} · {eventDateLabel(item)}</span></span></label>)}</fieldset> : ready && !error ? <p className="mt-4">No Trips or Events exist yet. <Link href="/events" className="font-semibold text-emerald-800 underline">Create a Trip/Event first</Link>.</p> : !error ? <p role="status" className="mt-4">Loading Trips & Events…</p> : null}
    {error ? <p role="alert" className="mt-4 text-red-700">{error} <button disabled={busy} onClick={() => { setError(null); setRetry(retry + 1); }} className="underline">Retry</button></p> : null}
    {ready && data.total_pages > 1 ? <nav aria-label="Trip/Event choices" className="mt-3 flex items-center justify-between gap-2"><button disabled={busy || page === 1} onClick={() => { setSelected(null); setPage(page - 1); }}>Previous</button><span>Page {page} of {data.total_pages}</span><button disabled={busy || page >= data.total_pages} onClick={() => { setSelected(null); setPage(page + 1); }}>Next</button></nav> : null}
    <div className="mt-5 flex gap-3"><button ref={cancel} disabled={busy} onClick={close} className="min-h-11 flex-1 rounded-md border px-3 font-semibold">Cancel</button><button disabled={busy || selected === null || !ready || Boolean(error)} onClick={() => void add()} className="min-h-11 flex-1 rounded-md bg-emerald-800 px-3 font-semibold text-white disabled:opacity-50">{busy ? "Adding…" : "Add to Trip/Event"}</button></div>
  </div></div>;
}
