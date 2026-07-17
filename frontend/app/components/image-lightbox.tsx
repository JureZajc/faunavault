"use client";

import { useEffect, useMemo, useState } from "react";

export type LightboxImage = {
  imageUrl: string;
  alt: string;
  caption?: string;
};

type ImageLightboxProps = {
  imageUrl?: string;
  alt?: string;
  caption?: string;
  images?: LightboxImage[];
  initialIndex?: number;
  onClose: () => void;
};

export default function ImageLightbox({
  imageUrl,
  alt = "",
  caption,
  images,
  initialIndex = 0,
  onClose,
}: ImageLightboxProps) {
  const availableImages = useMemo(
    () => images ?? (imageUrl ? [{ imageUrl, alt, caption }] : []),
    [alt, caption, imageUrl, images],
  );
  const [index, setIndex] = useState(
    Math.min(initialIndex, Math.max(availableImages.length - 1, 0)),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [hasFailed, setHasFailed] = useState(false);
  const current = availableImages[index];
  const hasPrevious = index > 0;
  const hasNext = index < availableImages.length - 1;

  function navigate(nextIndex: number) {
    setIsLoading(true);
    setHasFailed(false);
    setIndex(nextIndex);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && index > 0) navigate(index - 1);
      if (event.key === "ArrowRight") {
        if (index < availableImages.length - 1) navigate(index + 1);
      }
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [availableImages.length, index, onClose]);

  if (!current) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/95 px-4 py-5 sm:px-16" onClick={onClose}>
      <button type="button" aria-label="Close fullscreen image" onClick={onClose} className="absolute right-4 top-4 z-10 min-h-11 rounded-md border border-white/20 bg-black/40 px-4 text-sm font-semibold text-white hover:bg-white/10">Close</button>
      <button type="button" aria-label="Previous image" disabled={!hasPrevious} onClick={(event) => { event.stopPropagation(); navigate(index - 1); }} className="absolute left-3 z-10 h-12 w-12 rounded-full border border-white/20 bg-black/50 text-2xl text-white disabled:invisible sm:left-6">‹</button>
      <figure className="flex max-h-full max-w-full flex-col items-center gap-3" onClick={(event) => event.stopPropagation()}>
        <div className="relative flex min-h-48 min-w-48 items-center justify-center">
          {isLoading && !hasFailed ? <div className="absolute text-sm font-medium text-stone-300">Loading image…</div> : null}
          {hasFailed ? (
            <div className="flex h-64 w-[min(80vw,42rem)] items-center justify-center rounded-lg border border-white/20 bg-white/5 text-stone-300">Image unavailable</div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={current.imageUrl} alt={current.alt} onLoad={() => setIsLoading(false)} onError={() => { setIsLoading(false); setHasFailed(true); }} className={`max-h-[84vh] max-w-[90vw] object-contain shadow-2xl transition-opacity ${isLoading ? "opacity-0" : "opacity-100"}`} />
          )}
        </div>
        {current.caption ? <figcaption className="max-w-[90vw] truncate text-center text-sm text-stone-200">{current.caption}</figcaption> : null}
        {availableImages.length > 1 ? <span className="text-xs text-stone-400">{index + 1} of {availableImages.length}</span> : null}
      </figure>
      <button type="button" aria-label="Next image" disabled={!hasNext} onClick={(event) => { event.stopPropagation(); navigate(index + 1); }} className="absolute right-3 z-10 h-12 w-12 rounded-full border border-white/20 bg-black/50 text-2xl text-white disabled:invisible sm:right-6">›</button>
    </div>
  );
}
