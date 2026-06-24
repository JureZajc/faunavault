"use client";

import { useEffect } from "react";

type ImageLightboxProps = {
  imageUrl: string;
  alt: string;
  caption?: string;
  onClose: () => void;
};

export default function ImageLightbox({
  imageUrl,
  alt,
  caption,
  onClose,
}: ImageLightboxProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    const previousOverflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/95 px-4 py-5 sm:px-8"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close fullscreen image"
        onClick={onClose}
        className="absolute right-4 top-4 min-h-11 rounded-md border border-white/20 bg-black/40 px-4 text-sm font-semibold text-white shadow-lg transition hover:border-white/40 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/70 sm:right-6 sm:top-6"
      >
        Close
      </button>

      <figure
        className="flex max-h-full max-w-full flex-col items-center gap-3"
        onClick={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Backend localhost images must bypass Next image optimization. */}
        <img
          src={imageUrl}
          alt={alt}
          className="max-h-[84vh] max-w-[94vw] object-contain shadow-2xl sm:max-h-[88vh]"
        />
        {caption ? (
          <figcaption className="max-w-[94vw] truncate text-center text-sm text-stone-200">
            {caption}
          </figcaption>
        ) : null}
      </figure>
    </div>
  );
}
