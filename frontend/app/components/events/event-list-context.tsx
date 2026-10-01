"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useEvent } from "../../hooks/use-event";
import { addEventPhotos } from "../../lib/api";
import { eventDateLabel, eventId, eventKindLabel } from "../../lib/events";

export default function EventListContext({ id, adding = false, selectedIds = new Set<number>(), busy = false, revision, onSelect, onDates, onAdded, onBusyChange }: {
  id: string; adding?: boolean; selectedIds?: ReadonlySet<number>; busy?: boolean; revision?: unknown;
  onSelect?: () => void; onDates?: (start: string, end: string) => void; onAdded?: (message: string) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const detail = useEvent(eventId(id), revision);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  async function add() {
    if (!detail.data || busy || inFlight.current || !selectedIds.size) return;
    inFlight.current = true; setSaving(true); onBusyChange?.(true); setError(null);
    try { const result = await addEventPhotos(detail.data.id, [...selectedIds].sort((a, b) => a - b)); onAdded?.(`Added ${result.added_count} Photos to the Trip/Event${result.already_present_count ? `; ${result.already_present_count} already present` : ""}.`); await detail.refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not add Photos."); }
    finally { inFlight.current = false; setSaving(false); onBusyChange?.(false); }
  }
  const item = detail.data;
  return <section aria-label={adding ? "Add Photos to Trip/Event" : "Trip/Event source"} className="mb-5 rounded-lg border border-emerald-200 bg-white p-4">
    {detail.error ? <p role="alert">Trip/Event unavailable: {detail.error} <button className="underline" onClick={() => void detail.refresh()}>Retry</button> <Link href="/events" className="underline">Trips & Events</Link></p> : !item ? <p role="status">Loading Trip/Event…</p> : <>
      <h2 className="break-words text-xl font-semibold">{adding ? "Add Photos to " : ""}{eventKindLabel(item.kind)}: {item.title}</h2><p className="mt-1 text-sm text-stone-600">{eventDateLabel(item)}{item.location_label ? ` · ${item.location_label}` : ""} · {item.active_photo_count} active Photos</p>
      <p className="mt-2 text-sm text-stone-600">{adding ? "Date suggestions are a starting point. Search or filter, explicitly select Photos, then add them. No Photos are added automatically." : "Only explicit members are shown. Capture dates do not determine membership."}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Link href={`/events/${item.id}`} aria-disabled={busy || saving} onClick={(event) => { if (busy || saving) event.preventDefault(); }} className="inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-semibold">{adding ? "Back to Trip/Event" : "Open Trip/Event"}</Link>{adding ? <><button disabled={busy || saving} onClick={onSelect} className="min-h-11 rounded-md border px-3 text-sm font-semibold">Select Photos to add</button><button disabled={busy || saving} onClick={() => onDates?.(item.start_date, item.end_date)} className="min-h-11 rounded-md border px-3 text-sm font-semibold">Use current Trip/Event dates</button><button disabled={!selectedIds.size || busy || saving} onClick={() => void add()} className="min-h-11 rounded-md bg-emerald-800 px-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Adding…" : `Add selected to this ${eventKindLabel(item.kind)}`}</button></> : null}</div>
    </>}{error ? <p role="alert" className="mt-3 text-red-700">{error}</p> : null}
  </section>;
}
