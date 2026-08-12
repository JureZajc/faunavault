"use client";

import { useCallback, useState } from "react";
import ImageLightbox from "../image-lightbox";
import { imageUrl, Photo } from "../../lib/api";

export function photoDisplayTitle(photo: Photo) {
  return (
    photo.display_title?.trim() ||
    photo.breed_guess?.trim() ||
    photo.common_name?.trim() ||
    "Unclassified"
  );
}

export default function PhotoMedia({ photo }: { photo: Photo }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const detailImageUrl = photo.resized_filename
    ? imageUrl("resized", photo.resized_filename)
    : imageUrl("original", photo.stored_filename);
  const imageFailed = failedImageUrl === detailImageUrl;
  const closeLightbox = useCallback(() => setIsLightboxOpen(false), []);

  return (
    <>
      <section className="overflow-hidden rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
        <div className="overflow-hidden rounded-md bg-stone-100">
          {imageFailed ? (
            <div className="flex aspect-[4/3] max-h-[72vh] w-full items-center justify-center px-6 text-center text-sm font-medium text-stone-500">
              Image unavailable
            </div>
          ) : (
            <button
              type="button"
              aria-label="Open fullscreen image"
              onClick={() => setIsLightboxOpen(true)}
              className="group relative flex w-full cursor-zoom-in items-center justify-center focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- Backend localhost images must bypass Next image optimization. */}
              <img
                src={detailImageUrl}
                alt={photoDisplayTitle(photo)}
                className="max-h-[72vh] w-full object-contain"
                onError={() => setFailedImageUrl(detailImageUrl)}
              />
              <span className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-stone-950/75 px-3 py-1.5 text-xs font-semibold text-white opacity-0 shadow-lg transition group-hover:opacity-100 group-focus-visible:opacity-100">
                View fullscreen
              </span>
            </button>
          )}
        </div>
      </section>
      {isLightboxOpen ? (
        <ImageLightbox
          imageUrl={detailImageUrl}
          alt={photoDisplayTitle(photo)}
          caption={photoDisplayTitle(photo) || photo.common_name || undefined}
          onClose={closeLightbox}
        />
      ) : null}
    </>
  );
}
