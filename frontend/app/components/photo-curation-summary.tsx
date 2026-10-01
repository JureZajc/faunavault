import { Photo } from "../lib/api";

export default function PhotoCurationSummary({ photo }: { photo: Photo }) {
  if (!photo.is_favorite && photo.rating == null && !photo.culling_state) return null;
  return <span className="inline-flex items-center gap-2 text-xs font-medium text-stone-700">
    {photo.culling_state ? <span aria-label={photo.culling_state === "pick" ? "Picked" : "Rejected"} className={photo.culling_state === "pick" ? "text-emerald-800" : "text-red-800"}>{photo.culling_state === "pick" ? "Picked" : "Rejected"}</span> : null}
    {photo.is_favorite ? <span aria-label="Favorite"><span aria-hidden="true" className="text-rose-700">♥</span> Favorite</span> : null}
    {photo.rating != null ? <span aria-label={`Rated ${photo.rating} out of 5 stars`}><span aria-hidden="true" className="text-amber-700">★</span> {photo.rating}/5</span> : null}
  </span>;
}
