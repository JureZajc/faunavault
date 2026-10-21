"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createEvent, EventMetadata, getImportSession, ImportSession } from "../../lib/api";
import { importEventAddHref } from "../../lib/import-sessions";
import EventFormDialog from "./event-form-dialog";

export default function ImportEventCreateButton({ item }: { item: ImportSession }) {
  const router = useRouter(), params = useSearchParams();
  const [context, setContext] = useState<ImportSession | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const createdId = useRef<number | null>(null), request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function open() {
    if (request.current || createdId.current) return;
    const controller = new AbortController();
    request.current = controller; setLoading(true); setError(null);
    try {
      const fresh = await getImportSession(item.id, controller.signal);
      if (controller.signal.aborted) return;
      if (!fresh.active_count) throw new Error("This session has no available photos for assignment.");
      setContext(fresh);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Import Session unavailable.");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  async function save(metadata: EventMetadata) {
    if (createdId.current !== null) return;
    // Revalidate availability without replacing the user's edited form input.
    const fresh = await getImportSession(item.id);
    if (!fresh.active_count) throw new Error("This session has no available photos for assignment.");
    const result = await createEvent(metadata);
    createdId.current = result.id;
    setCreated(result.id);
    // A navigation failure must never turn a successful creation into a retry.
    try { router.push(importEventAddHref(item.id, result.id, new URLSearchParams(params.toString()))); }
    catch { setError("Trip/Event created. Use the link below to continue selecting photos."); }
  }
  return <>
    {created !== null ? <div role="status" className="mt-3 text-sm">
      <p>Trip/Event created. Select photos separately in the List.</p>
      <Link className="inline-flex min-h-11 items-center underline" href={importEventAddHref(item.id, created, new URLSearchParams(params.toString()))}>Continue selecting photos</Link>{" · "}
      <Link className="inline-flex min-h-11 items-center underline" href={`/events/${created}`}>Open new Trip/Event</Link>
    </div> : <button type="button" disabled={item.active_count === 0} aria-disabled={loading} onClick={() => void open()} className="mt-3 min-h-11 rounded-md border border-emerald-700 px-3 text-sm font-semibold text-emerald-900 disabled:opacity-50 aria-disabled:opacity-50">{loading ? "Loading Import Session…" : "Create Trip/Event"}</button>}
    {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
    {context && created === null ? <EventFormDialog importSession={context} onClose={() => setContext(null)} onSave={save} /> : null}
  </>;
}
