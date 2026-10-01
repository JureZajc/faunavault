"use client";
import { useState } from "react";
import { imageUrl, TimelinePhotoPreview } from "../lib/api";

export default function PhotoThumbnailPreview({ preview }: { preview: TimelinePhotoPreview }) {
  const [failed, setFailed] = useState(false);
  const title = preview.display_title?.trim() || preview.original_filename;
  return <div className="aspect-[4/3] min-w-0 overflow-hidden rounded-md bg-stone-100">{failed ? <div className="grid h-full place-items-center px-2 text-center text-xs text-stone-500">Image unavailable</div> :
    // eslint-disable-next-line @next/next/no-img-element -- Local archive thumbnail.
    <img src={imageUrl("thumbs", preview.thumbnail_filename)} alt={title} loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
  }</div>;
}
