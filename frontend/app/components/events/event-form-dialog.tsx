"use client";
import { FormEvent, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { EventMetadata } from "../../lib/api";

export default function EventFormDialog({ initial, onClose, onSave }: { initial?: EventMetadata; onClose: () => void; onSave: (metadata: EventMetadata) => Promise<unknown> }) {
  const [values, setValues] = useState<EventMetadata>(initial ? { kind: initial.kind, title: initial.title, start_date: initial.start_date, end_date: initial.end_date, location_label: initial.location_label, notes: initial.notes } : { kind: "trip", title: "", start_date: "", end_date: "", location_label: null, notes: null });
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLFormElement>(null), titleInput = useRef<HTMLInputElement>(null);
  const close = () => { if (!saving.current) onClose(); };
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef: root, initialFocusRef: titleInput, onClose: close, isBusy: busy });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    if (!values.title.trim() || !values.start_date || !values.end_date || values.start_date > values.end_date) { setError("Enter a title and a valid date range with start on or before end."); return; }
    saving.current = true; setBusy(true); setError(null);
    try { await onSave(values); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save Trip/Event."); }
    finally { saving.current = false; setBusy(false); }
  }
  const inputClass = "mt-1 min-h-11 w-full rounded-md border border-stone-300 px-3 py-2 disabled:opacity-50";
  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/40 p-3 sm:p-6">
    <form ref={root} onSubmit={submit} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="event-form-title" className="my-auto max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
      <h2 id="event-form-title" className="text-xl font-semibold">{initial ? "Edit" : "Create"} Trip/Event</h2>
      <fieldset disabled={busy} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">Type<select className={inputClass} value={values.kind} onChange={(event) => setValues({ ...values, kind: event.target.value as EventMetadata["kind"] })}><option value="trip">Trip</option><option value="event">Event</option></select></label>
        <label className="block text-sm font-medium">Title<input ref={titleInput} className={inputClass} required maxLength={100} value={values.title} onChange={(event) => setValues({ ...values, title: event.target.value })} /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-medium">Start date<input className={inputClass} type="date" required value={values.start_date} onChange={(event) => setValues({ ...values, start_date: event.target.value })} /></label><label className="block text-sm font-medium">End date<input className={inputClass} type="date" required value={values.end_date} onChange={(event) => setValues({ ...values, end_date: event.target.value })} /></label></div>
        <p className="text-xs text-stone-600">Both types may span one or several days. Dates describe the experience; they do not assign Photos.</p>
        <label className="block text-sm font-medium">Location (optional)<input className={inputClass} maxLength={200} value={values.location_label ?? ""} onChange={(event) => setValues({ ...values, location_label: event.target.value || null })} /></label>
        <label className="block text-sm font-medium">Notes (optional)<textarea className={inputClass} rows={4} maxLength={2000} value={values.notes ?? ""} onChange={(event) => setValues({ ...values, notes: event.target.value || null })} /></label>
      </fieldset>
      {error ? <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
      <div className="mt-5 flex gap-3"><button type="button" disabled={busy} onClick={close} className="min-h-11 flex-1 rounded-md border px-4 font-semibold">Cancel</button><button type="submit" disabled={busy} className="min-h-11 flex-1 rounded-md bg-emerald-800 px-4 font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : initial ? "Save changes" : "Create Trip/Event"}</button></div>
    </form>
  </div>;
}
