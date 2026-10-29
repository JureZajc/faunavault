"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getNearbyPhotos, NearbyPhotosResponse, NearbyRadius, Photo } from "../../lib/api";
import {
  formatNearbyDistance,
  hasValidPhotoGps,
  nearbyPhotoHref,
  NEARBY_RADII,
  parseNearbyRadius,
} from "../../lib/nearby-photos";
import { formatCameraLocalDate } from "../../lib/photo-metadata";
import PhotoThumbnailPreview from "../photo-thumbnail-preview";

export default function NearbyPhotosSection({ photo }: { photo: Photo }) {
  if (!hasValidPhotoGps(photo)) return null;
  return <NearbyResults key={`${photo.id}:${photo.latitude}:${photo.longitude}:${photo.updated_at}`} photo={photo} />;
}

function NearbyResults({ photo }: { photo: Photo }) {
  const searchParams = useSearchParams();
  const radius = parseNearbyRadius(searchParams.get("nearby_radius"));
  const [attempt, setAttempt] = useState(0);
  // A fresh identity on every change also covers 5 -> 1 -> 5: previously
  // completed 5 km data must not mask the new request's loading state.
  const requestKey = useMemo(() => ({ photoId: photo.id, radius, attempt }), [photo.id, radius, attempt]);
  const [state, setState] = useState<{ key: typeof requestKey; data?: NearbyPhotosResponse; error?: string }>();
  const current = state?.key === requestKey ? state : undefined;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    getNearbyPhotos(photo.id, radius, 12, controller.signal).then(
      (data) => {
        if (active) setState({ key: requestKey, data });
      },
      () => {
        if (active) setState({ key: requestKey, error: "Could not load nearby photos. Please try again." });
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [photo.id, radius, requestKey]);

  const data = current?.data;

  return (
    <section aria-labelledby="nearby-photos-title" className="mt-5 min-w-0 border-t border-stone-200 pt-5">
      <h2 id="nearby-photos-title" className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">Nearby Photos</h2>
      <p className="mt-1 text-sm text-stone-600">Discover photos captured within a circular radius of this location. Distances depend on GPS accuracy.</p>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm font-medium text-stone-700">
        Search radius
        <select value={radius} onChange={(event) => {
          const url = new URL(window.location.href);
          url.searchParams.set("nearby_radius", event.target.value);
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        }} className="min-h-11 rounded-md border border-stone-300 bg-white px-3 focus-visible:outline-2 focus-visible:outline-emerald-600">
          {NEARBY_RADII.map((value) => <option key={value} value={value}>{value} km</option>)}
        </select>
      </label>
      <div aria-live="polite" aria-atomic="true" className="mt-3 text-sm text-stone-600">
        <NearbyStatus state={current} radius={radius} />
      </div>
      {current?.error ? (
        <button type="button" onClick={() => setAttempt((value) => value + 1)} className="mt-2 min-h-11 rounded-md border border-emerald-300 px-3 text-sm font-semibold text-emerald-900 focus-visible:outline-2 focus-visible:outline-emerald-600">
          Retry nearby photos
        </button>
      ) : null}
      {data?.availability === "available" && data.items.length ? (
        <ul aria-label="Nearby photos" className="mt-3 grid min-w-0 grid-cols-2 gap-3">
          {data.items.map((preview) => {
            const title = preview.display_title?.trim() || preview.original_filename;
            return (
              <li key={preview.id} className="min-w-0">
                <Link href={nearbyPhotoHref(preview.id, photo.id, radius)} className="block min-w-0 rounded-md border border-stone-200 p-2 transition hover:border-emerald-400 focus-visible:outline-2 focus-visible:outline-emerald-600">
                  <PhotoThumbnailPreview preview={preview} />
                  <p className="mt-2 break-words text-sm font-semibold text-stone-900">{title}</p>
                  <p className="text-xs text-stone-600">{formatNearbyDistance(preview.distance_m)} away</p>
                  {preview.captured_at ? (
                    <time dateTime={preview.captured_at} className="mt-1 block text-xs text-stone-500">{formatCameraLocalDate(preview.captured_at)}</time>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function NearbyStatus({ state, radius }: { state?: { data?: NearbyPhotosResponse; error?: string }; radius: NearbyRadius }) {
  if (!state) return <p role="status">Loading nearby photos…</p>;
  if (state.error) return <p role="alert">{state.error}</p>;
  const data = state.data;
  if (data?.availability === "unavailable") return <p>Nearby photos are unavailable because this photo has no valid GPS location.</p>;
  if (!data?.total) return <p>No other photos found within {radius} km. {radius < 25 ? "Try a larger radius." : "Only active photos with valid GPS are included."}</p>;
  return <p>Within {radius} km · Showing {data.items.length} of {data.total} nearby photos</p>;
}
