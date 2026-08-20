"use client";

import { KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { useModalAccessibility } from "../hooks/use-modal-accessibility";

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const current = availableImages[index];
  const hasPrevious = index > 0;
  const hasNext = index < availableImages.length - 1;
  const { handleKeyDown: handleModalKeyDown } = useModalAccessibility({
    isOpen: Boolean(current),
    dialogRef,
    onClose,
  });

  function navigate(nextIndex: number) {
    setIsLoading(true);
    setHasFailed(false);
    setIndex(nextIndex);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    handleModalKeyDown(event);
    if (event.defaultPrevented) return;

    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.matches('a, button, input, select, textarea, [contenteditable="true"]')
    ) {
      return;
    }

    if (event.key === "ArrowLeft" && hasPrevious) {
      event.preventDefault();
      navigate(index - 1);
    } else if (event.key === "ArrowRight" && hasNext) {
      event.preventDefault();
      navigate(index + 1);
    }
  }

  if (!current) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={current.caption ? descriptionId : undefined}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/95 p-3 sm:items-center sm:px-16 sm:py-5"
    >
      <h2 id={titleId} className="sr-only">
        Fullscreen image viewer
      </h2>
      <button
        type="button"
        aria-label="Close fullscreen image"
        onClick={onClose}
        className="absolute right-4 top-4 z-10 min-h-11 rounded-md border border-white/20 bg-black/40 px-4 text-sm font-semibold text-white hover:bg-white/10"
      >
        Close
      </button>
      <button
        type="button"
        aria-label="Previous image"
        disabled={!hasPrevious}
        onClick={(event) => {
          event.stopPropagation();
          navigate(index - 1);
        }}
        className="absolute left-3 top-1/2 z-10 h-12 w-12 -translate-y-1/2 rounded-full border border-white/20 bg-black/50 text-2xl text-white disabled:invisible sm:left-6"
      >
        ‹
      </button>
      <figure
        className={`my-auto flex min-h-0 min-w-0 max-h-full max-w-full flex-col items-center gap-3 ${availableImages.length > 1 ? "px-12 sm:px-0" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="relative flex min-h-48 min-w-48 max-w-full items-center justify-center">
          {isLoading && !hasFailed ? (
            <div className="absolute text-sm font-medium text-stone-300">
              Loading image…
            </div>
          ) : null}
          {hasFailed ? (
            <div
              role="alert"
              className="flex h-64 max-h-[calc(100vh-8rem)] w-[min(80vw,42rem)] max-w-full items-center justify-center rounded-lg border border-white/20 bg-white/5 px-4 text-center text-stone-300"
            >
              Image unavailable
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={current.imageUrl}
              alt={current.alt}
              onLoad={() => setIsLoading(false)}
              onError={() => {
                setIsLoading(false);
                setHasFailed(true);
              }}
              className={`max-h-[calc(100vh-8rem)] max-w-full object-contain shadow-2xl transition-opacity ${isLoading ? "opacity-0" : "opacity-100"}`}
            />
          )}
        </div>
        {current.caption ? (
          <figcaption
            id={descriptionId}
            className="max-h-20 max-w-full overflow-y-auto break-words text-center text-sm text-stone-200"
          >
            {current.caption}
          </figcaption>
        ) : null}
        {availableImages.length > 1 ? (
          <span role="status" className="text-xs text-stone-400">
            {index + 1} of {availableImages.length}
          </span>
        ) : null}
      </figure>
      <button
        type="button"
        aria-label="Next image"
        disabled={!hasNext}
        onClick={(event) => {
          event.stopPropagation();
          navigate(index + 1);
        }}
        className="absolute right-3 top-1/2 z-10 h-12 w-12 -translate-y-1/2 rounded-full border border-white/20 bg-black/50 text-2xl text-white disabled:invisible sm:right-6"
      >
        ›
      </button>
    </div>
  );
}
