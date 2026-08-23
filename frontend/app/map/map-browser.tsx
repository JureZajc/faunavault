"use client";

import ArchiveNavigation from "../components/archive-navigation";
import { ArchivePhotoMap } from "../components/maps/map-boundaries";
import { usePhotoMapPoints } from "../hooks/use-photo-map-points";

export default function MapBrowser({
  focusPhotoId,
}: {
  focusPhotoId: number | null;
}) {
  const locations = usePhotoMapPoints();
  const pointCount = locations.points?.length ?? 0;

  return (
    <main className="min-h-screen min-w-0 overflow-x-hidden bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <ArchiveNavigation active="map" />
          <p className="text-sm text-stone-500 sm:text-right">
            Browse active photos by capture location
          </p>
        </div>

        <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Archive geography
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold">Photo Map</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
                Explore where your active geotagged photos were captured. Nearby
                photos are grouped until you zoom in.
              </p>
            </div>
            {!locations.isLoading && !locations.error ? (
              <p className="shrink-0 text-sm font-medium text-stone-600">
                {pointCount} geotagged {pointCount === 1 ? "photo" : "photos"}
              </p>
            ) : null}
          </div>
        </header>

        <section aria-labelledby="archive-map-heading" className="mt-5 min-w-0">
          <h2 id="archive-map-heading" className="sr-only">
            Interactive archive map
          </h2>
          {locations.isLoading ? (
            <div
              role="status"
              className="grid h-[clamp(24rem,calc(100dvh-13rem),56rem)] place-items-center rounded-lg border border-stone-200 bg-stone-200 text-sm text-stone-600"
            >
              Loading photo locations…
            </div>
          ) : locations.error ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700"
            >
              <p>{locations.error}</p>
              <button
                type="button"
                onClick={() => void locations.retry()}
                className="mt-3 min-h-11 rounded-md border border-red-200 bg-white px-4 font-semibold"
              >
                Retry
              </button>
            </div>
          ) : locations.points?.length ? (
            <ArchivePhotoMap
              points={locations.points}
              focusPhotoId={focusPhotoId}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white px-4 py-16 text-center">
              <h2 className="text-xl font-semibold">No geotagged photos yet</h2>
              <p className="mt-2 text-sm text-stone-500">
                Photos with GPS metadata will appear here automatically.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
