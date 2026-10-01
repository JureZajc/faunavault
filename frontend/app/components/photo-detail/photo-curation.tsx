"use client";

import { useRef, useState } from "react";
import { Photo, PhotoRating, PhotoUpdate, updatePhoto } from "../../lib/api";
import CullingDecisionControls from "./culling-decision-controls";

export default function PhotoCuration({ photo, disabled, onPhotoUpdated, onBusyChange, onError }: {
  photo: Photo; disabled: boolean; onPhotoUpdated: (photo: Photo) => void;
  onBusyChange: (busy: boolean) => void; onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const saving = useRef(false);
  async function save(values: PhotoUpdate) {
    if (disabled || saving.current) return;
    saving.current = true;
    setBusy(true); onBusyChange(true); onError(null); setNotice("");
    try {
      onPhotoUpdated(await updatePhoto(photo.id, values, photo.updated_at));
      setNotice("Saved");
    } catch (error) {
      onError(`Could not save Photo curation: ${error instanceof Error ? error.message : "Please try again."}`);
    } finally {
      saving.current = false; setBusy(false); onBusyChange(false);
    }
  }
  return <section aria-label="Photo curation" aria-busy={busy} className="mt-4 border-t border-stone-100 pt-4">
    <button type="button" aria-pressed={photo.is_favorite} disabled={disabled || busy} onClick={() => void save({ is_favorite: !photo.is_favorite })}
      className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50">
      <span aria-hidden="true" className="mr-2 text-rose-700">{photo.is_favorite ? "♥" : "♡"}</span>Favorite
    </button>
    <fieldset disabled={disabled || busy} className="mt-3">
      <legend className="text-sm font-medium text-stone-700">Rating</legend>
      <div className="flex flex-wrap items-center gap-1">
        {([1, 2, 3, 4, 5] as PhotoRating[]).map((rating) => <label key={rating} className="relative flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md focus-within:ring-2 focus-within:ring-emerald-700">
          <input type="radio" name={`photo-rating-${photo.id}`} value={rating} checked={photo.rating === rating} aria-label={`Rate ${rating} ${rating === 1 ? "star" : "stars"}`} onChange={() => void save({ rating })} className="peer sr-only" />
          <span aria-hidden="true" className={`text-2xl ${photo.rating !== null && photo.rating >= rating ? "text-amber-700" : "text-stone-400"}`}>★</span>
        </label>)}
        <button type="button" disabled={photo.rating == null || disabled || busy} onClick={() => void save({ rating: null })} className="min-h-11 px-2 text-sm font-semibold text-emerald-800 focus-visible:outline-2 disabled:opacity-50">Clear rating</button>
      </div>
    </fieldset>
    <p className="text-xs text-stone-600">{photo.rating == null ? "Unrated" : `${photo.rating} out of 5 stars`}</p>
    <CullingDecisionControls state={photo.culling_state} disabled={disabled || busy} onChange={(culling_state) => void save({ culling_state })} />
    <p role="status" className="text-xs text-stone-600">{busy ? "Saving…" : notice}</p>
  </section>;
}
