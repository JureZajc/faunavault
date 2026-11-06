"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useSightingResource } from "../../hooks/use-sighting-resource";
import { getPhotoSightings } from "../../lib/api";
import { formatCameraLocalDate } from "../../lib/photo-metadata";
import { sightingName } from "../../lib/sightings";
import { SightingError, SightingPagination } from "./sighting-controls";

export default function PhotoSightings({ photoId }: { photoId: number }) {
  const [page, setPage] = useState(1);
  const load = useCallback((signal: AbortSignal) => getPhotoSightings(photoId, page, signal), [photoId, page]);
  const { data, error, retry } = useSightingResource(load);
  return <section aria-labelledby="photo-sightings-title" className="rounded-lg border border-stone-200 bg-white p-4">
    <h2 id="photo-sightings-title" className="text-lg font-semibold">Sightings</h2>
    {error ? <SightingError message={error} retry={retry} /> : !data ? <p role="status" className="mt-2 text-sm">Loading sightings…</p> : <>
      {data.items.length ? <ul className="mt-2 divide-y divide-stone-100">
        {data.items.map((item) => <li key={item.id}>
          <Link href={`/sightings/${item.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 break-words text-emerald-900 underline">
            <span className="min-w-0">{sightingName(item)}</span>
            <time className="text-sm text-stone-600" dateTime={item.observed_at}>{formatCameraLocalDate(item.observed_at)}</time>
          </Link>
        </li>)}
      </ul> : <p className="mt-2 text-sm text-stone-600">This photo is not linked to any sightings.</p>}
      <SightingPagination page={page} totalPages={data.total_pages} onPage={setPage} label="Sightings linked to this photo" />
    </>}
  </section>;
}
