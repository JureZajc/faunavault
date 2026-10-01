"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ArchiveNavigation from "../components/archive-navigation";
import EventFormDialog from "../components/events/event-form-dialog";
import PhotoThumbnailPreview from "../components/photo-thumbnail-preview";
import { ArchiveEventPage, createEvent, EventMetadata, getEvents } from "../lib/api";
import { eventDateLabel, eventId, eventKindLabel } from "../lib/events";

export default function EventsBrowser() {
  const params = useSearchParams(), router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const page = eventId(params.get("page")) ?? 1;
  const kind = ["trip", "event"].includes(params.get("kind") ?? "") ? params.get("kind") as EventMetadata["kind"] : undefined;
  const key = `${page}:${kind ?? "all"}`;
  const [loaded, setLoaded] = useState<{ key: string; data: ArchiveEventPage } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0), [creating, setCreating] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getEvents(page, kind, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      const nearest = Math.max(1, data.total_pages);
      if (page > nearest) { const next = new URLSearchParams(); if (kind) next.set("kind", kind); if (nearest > 1) next.set("page", String(nearest)); routerRef.current.replace(`/events${next.size ? `?${next}` : ""}`, { scroll: false }); return; }
      setLoaded({ key, data }); setFailure(null);
    }).catch((error) => { if (!controller.signal.aborted) setFailure({ key, message: error instanceof Error ? error.message : "Could not load Trips & Events." }); });
    return () => controller.abort();
  }, [page, kind, key, retry]);
  const data = loaded?.key === key ? loaded.data : null, error = failure?.key === key ? failure.message : null;
  function navigate(nextKind: string, nextPage = 1) { const next = new URLSearchParams(); if (nextKind !== "all") next.set("kind", nextKind); if (nextPage > 1) next.set("page", String(nextPage)); router.push(`/events${next.size ? `?${next}` : ""}`, { scroll: false }); }
  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950"><div className="mx-auto max-w-7xl px-3 py-8 sm:px-6"><ArchiveNavigation active="events" />
    <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5"><h1 className="text-3xl font-semibold">Trips & Events</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">Group Photos around a real-world experience. Dates describe the experience; membership is your explicit choice.</p><div className="mt-4 flex flex-wrap gap-3"><button onClick={() => setCreating(true)} className="min-h-11 rounded-md bg-emerald-800 px-4 font-semibold text-white">Create Trip/Event</button><label className="flex min-h-11 items-center gap-2 text-sm font-semibold">Show<select aria-label="Trip/Event type filter" value={kind ?? "all"} onChange={(event) => navigate(event.target.value)} className="min-h-11 rounded-md border px-3"><option value="all">All</option><option value="trip">Trips</option><option value="event">Events</option></select></label></div></header>
    {error ? <div role="alert" className="mt-6 rounded-lg bg-red-50 p-5 text-red-700">{error} <button onClick={() => { setFailure(null); setRetry(retry + 1); }} className="underline">Retry</button></div> : !data ? <p role="status" className="mt-6">Loading Trips & Events…</p> : data.items.length ? <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.items.map((item) => <article key={item.id} className="min-w-0 rounded-xl border border-stone-200 bg-white p-4 shadow-sm"><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">{eventKindLabel(item.kind)}</p><h2 className="mt-2 break-words text-xl font-semibold"><Link href={`/events/${item.id}`} className="hover:text-emerald-800">{item.title}</Link></h2><p className="mt-2 text-sm text-stone-600">{eventDateLabel(item)}</p>{item.location_label ? <p className="mt-1 break-words text-sm text-stone-600">{item.location_label}</p> : null}<p className="mt-2 text-sm font-medium">{item.active_photo_count} active {item.active_photo_count === 1 ? "Photo" : "Photos"}</p><div className="mt-3 grid grid-cols-2 gap-2">{item.previews.map((preview) => <PhotoThumbnailPreview key={preview.id} preview={preview} />)}</div></article>)}</div> : <section className="mt-6 rounded-xl border border-dashed bg-white p-12 text-center"><h2 className="text-xl font-semibold">{kind ? `No ${kind === "trip" ? "Trips" : "Events"} yet` : "No Trips & Events yet"}</h2><p className="mt-2 text-stone-600">Create a Trip or Event to group photos around a real-world experience.</p></section>}
    {data && data.total_pages > 1 ? <nav aria-label="Trips & Events pagination" className="mt-6 flex items-center justify-center gap-3"><button disabled={page === 1} onClick={() => navigate(kind ?? "all", page - 1)} className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-50">Previous</button><span>Page {page} of {data.total_pages}</span><button disabled={page >= data.total_pages} onClick={() => navigate(kind ?? "all", page + 1)} className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-50">Next</button></nav> : null}
  </div>{creating ? <EventFormDialog onClose={() => setCreating(false)} onSave={async (values) => { const saved = await createEvent(values); router.push(`/events/${saved.id}`); }} /> : null}</main>;
}
