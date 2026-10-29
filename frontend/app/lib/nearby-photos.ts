import { NearbyRadius, Photo } from "./api";

export const NEARBY_RADII = [1, 5, 10, 25] as const;

export function parseNearbyRadius(value: string | null): NearbyRadius {
  return NEARBY_RADII.find((radius) => String(radius) === value) ?? 5;
}

export function hasValidPhotoGps(photo: Pick<Photo, "latitude" | "longitude">) {
  return typeof photo.latitude === "number" && Number.isFinite(photo.latitude) && Math.abs(photo.latitude) <= 90
    && typeof photo.longitude === "number" && Number.isFinite(photo.longitude) && Math.abs(photo.longitude) <= 180;
}

export function formatNearbyDistance(meters: number) {
  return meters < 1000 ? `${Math.min(999, Math.round(meters))} m` : `${Number((meters / 1000).toFixed(1))} km`;
}

export function nearbyPhotoHref(photoId: number, sourceId: number, radius: NearbyRadius) {
  // One local source hop only: never copy an existing, possibly nested returnTo.
  const source = `/photos/${sourceId}?nearby_radius=${radius}`;
  return `/photos/${photoId}?returnTo=${encodeURIComponent(source)}`;
}
