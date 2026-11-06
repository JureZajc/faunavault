"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import ArchiveNavigation from "../../components/archive-navigation";
import PhotoCard from "../../components/catalog/photo-card";
import ConfirmDialog from "../../components/confirm-dialog";
import { PhotoLocationMap } from "../../components/maps/map-boundaries";
import PaginatedPhotoGallery from "../../components/paginated-photo-gallery";
import { buttonStyle, SightingError, SightingPagination } from "../../components/sightings/sighting-controls";
import SightingFormDialog from "../../components/sightings/sighting-form-dialog";
import { useSightingResource } from "../../hooks/use-sighting-resource";
import { changeSightingPhotos, deleteSighting, getSighting, getSightingPhotos, Photo, Sighting } from "../../lib/api";
import { hasValidCoordinates } from "../../lib/geographic-bounds";
import { formatCameraLocalDate, formatUtcOffset } from "../../lib/photo-metadata";
import { sightingMapHref } from "../../lib/sighting-map-query";
import { sightingName, taxonLabel } from "../../lib/sightings";

export default function SightingDetail({ id }: { id: number | null }) {
  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl space-y-5 px-3 py-8 sm:px-6">
      <ArchiveNavigation active="sightings" />
      <Link href="/sightings" className={buttonStyle}>Back to Sightings Journal</Link>
      {id === null ? <SightingError message="Invalid sighting ID." /> : <SightingRecord key={id} id={id} />}
    </div>
  </main>;
}

function SightingRecord({ id }: { id: number }) {
  const router = useRouter();
  const load = useCallback((signal: AbortSignal) => getSighting(id, signal), [id]);
  const { data: item, error, retry, replace } = useSightingResource(load);
  const [dialog, setDialog] = useState<"edit" | "delete" | null>(null);
  if (error) return <SightingError message={error} retry={retry} />;
  if (!item) return <p role="status">Loading sighting…</p>;
  const name = sightingName(item);
  const hasLocation = hasValidCoordinates(item.latitude, item.longitude);
  return <>
    <article className="space-y-4 rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 break-words text-3xl font-semibold">{name}</h1>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonStyle} onClick={() => setDialog("edit")}>Edit Sighting</button>
          <button type="button" className={`${buttonStyle} text-red-800`} onClick={() => setDialog("delete")}>Delete Sighting</button>
        </div>
      </div>
      <dl className="grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-sm font-semibold">Observed</dt>
          <dd><time dateTime={item.observed_at}>{formatCameraLocalDate(item.observed_at, true, true)}</time>
            {" · "}{item.observed_at_offset_minutes === null ? "UTC offset unknown" : formatUtcOffset(item.observed_at_offset_minutes)}</dd>
        </div>
        <div className="min-w-0 break-words">
          <dt className="text-sm font-semibold">Identification</dt>
          <dd>{item.taxon ? <>Verified species: {taxonLabel(item.taxon)} <span className="italic">({item.taxon.scientific_name})</span></> : "Unidentified"}</dd>
        </div>
        <div className="min-w-0 break-words">
          <dt className="text-sm font-semibold">Location</dt>
          <dd>{item.location_label || (hasLocation ? "GPS location" : "No location recorded")}</dd>
          {hasLocation && <dd className="text-sm text-stone-600">{item.latitude}, {item.longitude}</dd>}
          {!hasLocation && <dd className="text-sm text-stone-600">Add Sighting coordinates to show this encounter on the map.</dd>}
        </div>
        <div className="min-w-0">
          <dt className="text-sm font-semibold">Field notes</dt>
          <dd className="whitespace-pre-wrap break-words">{item.notes || "No field notes"}</dd>
        </div>
      </dl>
      {hasLocation && item.latitude !== null && item.longitude !== null && <>
        <Link href={sightingMapHref({ focus: id })} className={buttonStyle}>View on Sightings Map</Link>
        <PhotoLocationMap latitude={item.latitude} longitude={item.longitude} label={item.location_label || name} />
      </>}
    </article>
    <SightingGallery item={item} onChanged={replace} />
    {dialog === "edit" && <SightingFormDialog item={item} onClose={() => setDialog(null)} onSaved={(updated) => { replace(updated); setDialog(null); }} />}
    {dialog === "delete" && <ConfirmDialog title="Delete Sighting?" description={`Delete “${name}” and its photo links? Your photos will stay in the archive.`} action="Delete Sighting"
      onClose={() => setDialog(null)} onConfirm={async () => { await deleteSighting(id); router.push("/sightings"); }} />}
  </>;
}

function SightingGallery({ item, onChanged }: { item: Sighting; onChanged: (item: Sighting) => void }) {
  const { id } = item;
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<Photo | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const load = useCallback((signal: AbortSignal) => getSightingPhotos(id, page, signal), [id, page]);
  const { data, error, retry } = useSightingResource(load);
  const returnTo = `/sightings/${id}`;
  return <section aria-labelledby="sighting-photos-title" className="space-y-3 rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="sighting-photos-title" className="text-xl font-semibold">Linked photos</h2>
        <p className="text-sm text-stone-600" role="status">{item.active_photo_count} active · {item.trash_photo_count} in Trash</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {item.active_photo_count > 0 && <button type="button" className={buttonStyle} onClick={() => setGalleryOpen(true)}>Open gallery</button>}
        <Link className={buttonStyle} href={`/?add_to_sighting=${id}`}>Add existing photos</Link>
      </div>
    </div>
    {error ? <SightingError message={error} retry={retry} /> : !data ? <p role="status">Loading linked photos…</p> : <>
      {data.items.length ? <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data.items.map((photo) => <li key={photo.id} className="min-w-0">
          <PhotoCard photo={photo} returnTo={returnTo}
            action={<button type="button" className={`${buttonStyle} text-red-800`} aria-label={`Remove ${photo.original_filename} from sighting`} onClick={() => setRemoving(photo)}>Remove from sighting</button>} />
        </li>)}
      </ul> : <p>No active photos linked to this sighting.</p>}
      {data.total_pages < page ? <button type="button" className={buttonStyle} onClick={() => setPage(Math.max(1, data.total_pages))}>Back to linked photos</button>
        : <SightingPagination page={page} totalPages={data.total_pages} onPage={setPage} label="Linked photo pages" />}
    </>}
    {galleryOpen && <PaginatedPhotoGallery kind="sighting" id={id} start={{ page: 1, index: 0 }} onClose={() => setGalleryOpen(false)} />}
    {removing && <ConfirmDialog title="Remove photo from sighting?" description={`Remove the link to ${removing.original_filename}? The photo will stay in your archive.`}
      action="Remove photo" onClose={() => setRemoving(null)} onConfirm={async () => {
        onChanged(await changeSightingPhotos(id, [removing.id], "remove"));
        if (page > 1 && data?.items.length === 1) setPage(page - 1);
        else retry();
      }} />}
  </section>;
}
