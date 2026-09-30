import { PhotoMapPoint } from "./api";
import { formatCameraLocalDate } from "./photo-metadata";

export function parsePhotoFocusId(value: string | string[] | undefined) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function photoMapPointTitle(point: PhotoMapPoint) {
  return (
    point.display_title?.trim() ||
    point.common_name?.trim() ||
    point.original_filename
  );
}

export function photoMapMarkerLabel(point: PhotoMapPoint) {
  return `Open map preview for ${photoMapPointTitle(point)}`;
}

export function photoMapCapturedDate(point: PhotoMapPoint) {
  return point.captured_at
    ? formatCameraLocalDate(point.captured_at)
    : null;
}

export function photoMapDetailHref(point: PhotoMapPoint, mapHref = "/map") {
  const [pathname, query] = mapHref.split("?");
  const params = new URLSearchParams(query);
  params.set("photo", String(point.id));
  const returnTo = `${pathname}?${params}`;
  return `/photos/${point.id}?returnTo=${encodeURIComponent(returnTo)}`;
}
