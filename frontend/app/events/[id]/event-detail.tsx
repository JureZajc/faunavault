"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ArchiveNavigation from "../../components/archive-navigation";
import PhotoCard from "../../components/catalog/photo-card";
import EventFormDialog from "../../components/events/event-form-dialog";
import EventConfirmDialog from "../../components/events/event-confirm-dialog";
import { useEvent } from "../../hooks/use-event";
import { usePhotoCatalog } from "../../hooks/use-photo-catalog";
import { useCatalogSelection } from "../../hooks/use-catalog-selection";
import { deleteEvent, removeEventPhotos, updateEvent } from "../../lib/api";
import { DEFAULT_CATALOG_STATE } from "../../lib/catalog-query";
import { eventAddHref, eventCullHref, eventDateHref, eventDateLabel, eventId as parseId, eventKindLabel, eventListHref, eventMapHref } from "../../lib/events";
import { compareHref } from "../../lib/photo-compare";

export default function EventDetail({ eventId }: { eventId: number | null }) {
  const router = useRouter(), params = useSearchParams();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const page = parseId(params.get("page")) ?? 1;
  const detail = useEvent(eventId);
  const href = page > 1 ? `/events/${eventId}?page=${page}` : `/events/${eventId}`;
  const pageHref = useCallback((value: number) => `/events/${eventId}${value > 1 ? `?page=${value}` : ""}`, [eventId]);
  const correctPage = useCallback((value: number) => routerRef.current.replace(pageHref(value), { scroll: false }), [pageHref]);
  const query = useMemo(() => ({ ...DEFAULT_CATALOG_STATE, event_id: eventId ?? 0, page }), [eventId, page]);
  const catalog = usePhotoCatalog(query, correctPage);
  const selection = useCatalogSelection(`event:${eventId}`);
  const [edit, setEdit] = useState(false), [deleting, setDeleting] = useState(false), [removeIds, setRemoveIds] = useState<number[] | null>(null), [notice, setNotice] = useState<string | null>(null);
  const item = detail.data, photos = catalog.data?.items ?? [];
  const button = "inline-flex min-h-11 items-center justify-center rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold disabled:opacity-50";
  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950"><div className="mx-auto max-w-7xl px-3 py-8 sm:px-6"><ArchiveNavigation active="events" />
    {detail.error ? <div role="alert" className="mt-6 rounded-lg bg-red-50 p-5 text-red-700"><h1 className="text-xl font-semibold">Trip/Event unavailable</h1><p>{detail.error}</p><button onClick={() => void detail.refresh()} className="mt-3 underline">Retry</button><Link href="/events" className="ml-4 underline">Back to Trips & Events</Link></div> : !item ? <p role="status" className="mt-6">Loading Trip/Event…</p> : <>
      <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5"><p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">{eventKindLabel(item.kind)}</p><h1 className="mt-2 break-words text-3xl font-semibold">{item.title}</h1><p className="mt-2 text-stone-600">{eventDateLabel(item)}</p>{item.location_label ? <p className="mt-1 break-words text-stone-600">{item.location_label}</p> : null}{item.notes ? <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-stone-700">{item.notes}</p> : null}<p className="mt-4 font-semibold">{item.active_photo_count} active Photos · {item.undecided_count} undecided · {item.pick_count} picked · {item.reject_count} rejected</p>{item.trash_photo_count ? <p className="mt-1 text-sm text-stone-600">{item.trash_photo_count} member Photos in Trash; restoring them returns them here.</p> : null}<p className="mt-3 text-sm text-stone-600">Membership is explicit. Editing these dates or a Photo’s capture date does not change membership.</p>
      <div className="mt-4 flex flex-wrap gap-2"><Link className={button} href={eventAddHref(item)}>Add Photos</Link><Link className={button} href={eventAddHref(item, true)}>Add suggested photos</Link><Link className={button} href={eventListHref(item.id)}>View in List</Link><Link className={button} href={eventMapHref(item.id)}>View on Map</Link><Link className={button} href={eventCullHref(item.id)}>Cull this {eventKindLabel(item.kind)}</Link><Link className={button} href={eventDateHref(item)}>View date range in List</Link><button className={button} onClick={() => setEdit(true)}>Edit Trip/Event</button><button className={button + " text-red-700"} onClick={() => setDeleting(true)}>Delete Trip/Event</button></div><p className="mt-2 text-xs text-stone-500">Map shows members with GPS. Date range in List shows all matching archive Photos, including nonmembers.</p></header>
      {notice ? <p role="status" className="mt-4 rounded-md bg-emerald-50 p-3 text-emerald-900">{notice}</p> : null}
      <section className="mt-5" aria-label="Trip/Event Photos">
        {selection.isSelecting ? <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-3"><p className="mr-2 font-semibold">{selection.selectedCount} selected</p><button className={button} onClick={() => selection.togglePage(photos.map((photo) => photo.id))}>Select / clear page</button><button className={button} disabled={!selection.selectedCount} onClick={() => setRemoveIds([...selection.selectedIds].sort((a, b) => a - b))}>Remove selected</button><button className={button} disabled={selection.selectedCount !== 2} onClick={() => { const [left, right] = [...selection.selectedIds].sort((a, b) => a - b); selection.reset(); router.push(compareHref(left, right, href)); }}>Compare</button><button className={button} onClick={selection.clear}>Clear selection</button><button className={button} onClick={selection.reset}>Exit selection</button>{selection.error ? <p role="alert">{selection.error}</p> : null}</div> : <button className={button} disabled={!photos.length} onClick={selection.enter}>Select photos</button>}
        {catalog.error ? <p role="alert" className="mt-4 text-red-700">{catalog.error} <button className="underline" onClick={() => void catalog.refresh().catch(() => undefined)}>Retry Photos</button></p> : catalog.isLoading ? <p role="status" className="mt-4">Loading member Photos…</p> : photos.length ? <div className="grid items-stretch gap-5 py-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{photos.map((photo) => <PhotoCard key={photo.id} photo={photo} returnTo={href} isSelectionMode={selection.isSelecting} isSelected={selection.selectedIds.has(photo.id)} onToggleSelection={selection.toggle} action={<button className={button + " w-full"} onClick={() => setRemoveIds([photo.id])}>Remove from {eventKindLabel(item.kind)}</button>} />)}</div> : <div className="mt-5 rounded-xl border border-dashed bg-white p-12 text-center"><h2 className="text-xl font-semibold">{item.trash_photo_count ? "All member Photos are in Trash" : "No Photos in this Trip/Event yet"}</h2><p className="mt-2 text-stone-600">Use Add Photos or date suggestions to explicitly choose members.</p></div>}
        {catalog.data && catalog.data.total_pages > 1 ? <nav aria-label="Trip/Event Photo pagination" className="mt-4 flex items-center justify-center gap-3"><button className={button} disabled={page === 1 || catalog.isLoading} onClick={() => router.push(pageHref(page - 1), { scroll: false })}>Previous</button><span>Page {page} of {catalog.data.total_pages}</span><button className={button} disabled={page >= catalog.data.total_pages || catalog.isLoading} onClick={() => router.push(pageHref(page + 1), { scroll: false })}>Next</button></nav> : null}
      </section>
    </>}
  </div>{item && edit ? <EventFormDialog initial={item} onClose={() => setEdit(false)} onSave={async (metadata) => { const saved = await updateEvent(item.id, metadata); detail.setData(saved); setNotice("Updated Trip/Event metadata. Membership is unchanged."); }} /> : null}
    {item && deleting ? <EventConfirmDialog title={`Delete ${eventKindLabel(item.kind)} “${item.title}”?`} description="This deletes the Trip/Event and its memberships. Photos remain in FaunaVault, including those in Trash." action="Delete Trip/Event" onClose={() => setDeleting(false)} onConfirm={async () => { await deleteEvent(item.id); router.push("/events"); }} /> : null}
    {item && removeIds ? <EventConfirmDialog title={`Remove ${removeIds.length} ${removeIds.length === 1 ? "Photo" : "Photos"} from this ${eventKindLabel(item.kind)}?`} description="Only these memberships are removed. The Photos remain in FaunaVault and in any other Trips, Events, or Collections." action="Remove memberships" onClose={() => setRemoveIds(null)} onConfirm={async () => { const result = await removeEventPhotos(item.id, removeIds); setRemoveIds(null); selection.reset(); setNotice(`Removed ${result.removed_count} memberships. Photos remain in FaunaVault.`); await detail.refresh(); await catalog.refresh().catch(() => setNotice("Memberships removed, but Photos could not refresh. Use Retry Photos.")); }} /> : null}
  </main>;
}
