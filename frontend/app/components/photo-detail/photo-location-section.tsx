"use client";

import Link from "next/link";
import { Photo } from "../../lib/api";
import { PhotoLocationMap } from "../maps/map-boundaries";
import { photoDisplayTitle } from "./photo-media";

export default function PhotoLocationSection({ photo }: { photo: Photo }) {
  if (photo.latitude === null || photo.longitude === null) return null;
  const title = photoDisplayTitle(photo);

  return (
    <section aria-labelledby="photo-location-map-title" className="mt-5 border-t border-stone-200 pt-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            id="photo-location-map-title"
            className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500"
          >
            Location map
          </h2>
          <p className="mt-1 text-sm text-stone-600">Where this photo was taken</p>
        </div>
        <Link
          href={`/map?photo=${photo.id}`}
          className="inline-flex min-h-10 items-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-100"
        >
          View on map
        </Link>
      </div>
      <PhotoLocationMap
        latitude={photo.latitude}
        longitude={photo.longitude}
        label={title}
      />
    </section>
  );
}
