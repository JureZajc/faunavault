import { Photo } from "./api";
import { formatCameraLocalDate, formatUtcOffset } from "./photo-metadata";

export function parseComparePair(params: URLSearchParams) {
  const read = (name: string) => {
    const values = params.getAll(name);
    const value = values[0];
    return values.length === 1 && /^[1-9]\d*$/.test(value ?? "") && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  const left = read("left"), right = read("right");
  if (left === null || right === null) return { pair: null, error: "Choose exactly two photos using one valid left ID and one valid right ID." };
  if (left === right) return { pair: null, error: "Choose two different photos to compare." };
  return { pair: { left, right }, error: null };
}

export function compareReturnLocation(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f]/.test(value)) return "/";
  try {
    const origin = "http://faunavault.local";
    const url = new URL(value, origin);
    if (url.origin !== origin || !["/", "/duplicates", "/cull"].includes(url.pathname)) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}

export function compareHref(left: number, right: number, returnTo: string) {
  return `/compare?${new URLSearchParams({ left: String(left), right: String(right), returnTo })}`;
}

export function compareMetadata(photo: Photo) {
  const make = photo.camera_make?.trim(), model = photo.camera_model?.trim();
  const camera = make && model && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model || make;
  const bytes = photo.original_size_bytes;
  const filesize = bytes == null ? "Not recorded" : bytes < 1024 ? `${bytes} B` : `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(bytes / (bytes < 1048576 ? 1024 : 1048576))} ${bytes < 1048576 ? "KB" : "MB"}`;
  return [
    ["Capture time", photo.captured_at ? `${formatCameraLocalDate(photo.captured_at, true, true)} · ${photo.captured_at_offset_minutes === null ? "timezone not recorded" : formatUtcOffset(photo.captured_at_offset_minutes)}` : "Not recorded"],
    ["Dimensions", photo.image_width != null && photo.image_height != null ? `${photo.image_width} × ${photo.image_height}` : "Not recorded"],
    ["Filesize", filesize],
    ["Category", photo.category || "Not recorded"],
    ["Species", photo.species_guess || "Not identified"],
    ["Camera", camera || "Not recorded"],
    ["Lens", photo.lens_model || "Not recorded"],
    ["GPS", photo.latitude != null && photo.longitude != null ? "Recorded" : "Not recorded"],
  ] as const;
}

export function canInspectOriginal(photo: Photo) {
  return /\.(jpe?g|png|webp)$/i.test(photo.stored_filename) && (!photo.media_type || ["image/jpeg", "image/png", "image/webp"].includes(photo.media_type));
}
