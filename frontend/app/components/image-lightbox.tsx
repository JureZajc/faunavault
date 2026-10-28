"use client";

import { KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useModalAccessibility } from "../hooks/use-modal-accessibility";

export type LightboxImage = { imageUrl: string; alt: string; caption?: string };

// Optional controlled navigation lets paginated sources reuse the same viewer.
export type LightboxNavigation = {
  index: number;
  total: number;
  busy: boolean;
  error: string | null;
  onNavigate: (index: number) => Promise<boolean>;
  onRetry: () => void;
  onSkip?: () => void;
};

type ImageLightboxProps = {
  imageUrl?: string;
  alt?: string;
  caption?: string;
  images?: LightboxImage[];
  initialIndex?: number;
  navigation?: LightboxNavigation;
  onClose: () => void;
};

export default function ImageLightbox({
  imageUrl, alt = "", caption, images, initialIndex = 0, navigation, onClose,
}: ImageLightboxProps) {
  const availableImages = useMemo(
    () => images ?? (imageUrl ? [{ imageUrl, alt, caption }] : []),
    [alt, caption, imageUrl, images],
  );
  const [localIndex, setIndex] = useState(Math.max(0, Math.min(initialIndex, availableImages.length - 1)));
  const index = navigation?.index ?? localIndex;
  const total = navigation?.total ?? availableImages.length;
  const current = availableImages[navigation ? 0 : localIndex];
  const [loaded, setLoaded] = useState("");
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const imageKey = `${index}:${current?.imageUrl}:${attempt}`;
  const isLoading = Boolean(current) && loaded !== imageKey;
  const hasFailed = failed === imageKey;
  const [playing, setPlaying] = useState(false);
  const [interval, setIntervalSeconds] = useState(5);
  const [reducedMotion, setReducedMotion] = useState(false);
  const busy = navigation?.busy ?? false;
  const error = navigation?.error;
  const hasPrevious = index > 0;
  const hasNext = index < total - 1;
  const isPlaying = playing && hasNext && !hasFailed && !error;
  const cannotPlay = !hasNext || busy || hasFailed || Boolean(error) || !current;
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId(), descriptionId = useId();
  const { handleKeyDown: handleModalKeyDown } = useModalAccessibility({
    isOpen: Boolean(current || navigation), dialogRef, onClose,
  });

  useEffect(() => {
    const pauseHidden = () => { if (document.hidden) setPlaying(false); };
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(media?.matches ?? false);
    updateMotion();
    document.addEventListener("visibilitychange", pauseHidden);
    media?.addEventListener("change", updateMotion);
    return () => {
      document.removeEventListener("visibilitychange", pauseHidden);
      media?.removeEventListener("change", updateMotion);
    };
  }, []);

  const advance = useCallback(async (nextIndex: number) => {
    if (busy || nextIndex < 0 || nextIndex >= total) return;
    if (navigation) {
      if (!await navigation.onNavigate(nextIndex) || nextIndex === total - 1) setPlaying(false);
    } else {
      setIndex(nextIndex);
      if (nextIndex === total - 1) setPlaying(false);
    }
  }, [busy, navigation, total]);

  useEffect(() => {
    if (!isPlaying || isLoading || busy || !current || document.hidden) return;
    const timer = window.setTimeout(() => void advance(index + 1), interval * 1000);
    return () => window.clearTimeout(timer);
  }, [advance, busy, current, index, interval, isLoading, isPlaying]);

  function navigate(nextIndex: number) {
    setPlaying(false);
    void advance(nextIndex);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keep gallery keys away from document-level Culling shortcuts.
    event.stopPropagation();
    handleModalKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.target instanceof HTMLElement &&
      event.target.closest('a, button, input, select, textarea, [contenteditable="true"]')) return;
    if (event.key === "ArrowLeft" && hasPrevious) {
      event.preventDefault(); navigate(index - 1);
    } else if (event.key === "ArrowRight" && hasNext) {
      event.preventDefault(); navigate(index + 1);
    }
  }

  if (!current && !navigation) return null;
  // Keep focus when navigation becomes unavailable during loading or at a boundary.
  // Native disabled buttons can drop focus to the page behind the dialog.
  const control = "min-h-11 rounded-md border border-white/20 bg-black/60 px-4 text-sm font-semibold text-white hover:bg-white/10 aria-disabled:opacity-40";
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
      aria-describedby={current?.caption ? descriptionId : undefined} tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="fixed inset-0 z-50 flex h-dvh flex-col items-center justify-center overflow-hidden bg-stone-950 px-3 pb-3 pt-16 sm:px-20">
      <h2 id={titleId} className="sr-only">Fullscreen image viewer</h2>
      <button type="button" aria-label="Close fullscreen image" onClick={onClose}
        className={control + " absolute right-4 top-3 z-10"}>Close</button>
      <button type="button" aria-label="Previous image" aria-disabled={!hasPrevious || busy}
        onClick={() => { if (hasPrevious && !busy) navigate(index - 1); }}
        className={control + " absolute left-2 top-1/2 z-10 h-12 w-12 -translate-y-1/2 !px-0 text-2xl sm:left-5"}>‹</button>
      <figure className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-12 sm:px-0"
        onClick={(event) => event.stopPropagation()}>
        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center" aria-busy={busy || isLoading}>
          {(busy || (isLoading && !hasFailed)) && !error ? <p role="status" className="absolute text-sm text-stone-300">{busy ? "Loading gallery…" : "Loading image…"}</p> : null}
          {error ? <div role="alert" className="relative rounded-lg bg-stone-950 p-4 text-center text-stone-200">
            <p>{error}</p><button type="button" className={control + " mt-3"} onClick={() => { setPlaying(false); navigation?.onRetry(); }}>Retry page</button>
            {navigation?.onSkip ? <button type="button" className={control + " ml-2 mt-3"} onClick={() => { setPlaying(false); navigation.onSkip?.(); }}>Skip page</button> : null}
          </div> : hasFailed ? <div role="alert" className="text-center text-stone-300">
            <p>Image unavailable</p><button type="button" className={control + " mt-3"} onClick={() => setAttempt((value) => value + 1)}>Retry image</button>
            {hasNext ? <button type="button" className={control + " ml-2 mt-3"} onClick={() => navigate(index + 1)}>Skip image</button> : null}
          </div> : current ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={imageKey} src={current.imageUrl} alt={current.alt}
              onLoad={() => setLoaded(imageKey)}
              onError={() => { setLoaded(imageKey); setFailed(imageKey); setPlaying(false); }}
              className={`max-h-full max-w-full object-contain shadow-2xl motion-safe:transition-opacity ${isLoading || busy ? "opacity-0" : "opacity-100"}`} />
          ) : !busy ? <p role="status" className="text-stone-300">No active Photos in this gallery.</p> : null}
        </div>
        {current?.caption ? <figcaption id={descriptionId} className="max-h-20 max-w-full shrink-0 overflow-y-auto break-words text-center text-sm text-stone-200">{current.caption}</figcaption> : null}
        <span role="status" aria-live={isPlaying ? "off" : "polite"} className="shrink-0 text-xs text-stone-400">{current ? index + 1 : 0} of {total}</span>
      </figure>
      {total > 1 ? <div className="mt-3 flex shrink-0 flex-wrap items-center justify-center gap-2" onClick={(event) => event.stopPropagation()}>
        <button type="button" aria-label={isPlaying ? "Pause slideshow" : "Play slideshow"} aria-pressed={Boolean(isPlaying)}
          aria-disabled={!isPlaying && cannotPlay}
          onClick={() => { if (isPlaying || !cannotPlay) setPlaying(!isPlaying); }} className={control}>{isPlaying ? "Pause" : "Play"}</button>
        <label className="text-sm text-stone-300">Interval <select aria-label="Slideshow interval" value={interval}
          onChange={(event) => setIntervalSeconds(Number(event.target.value))} className="min-h-11 rounded-md border border-white/20 bg-stone-900 px-2 text-white">
          {[3, 5, 10].map((seconds) => <option key={seconds} value={seconds}>{seconds} seconds</option>)}
        </select></label>
        <span role="status" className="text-xs text-stone-400">{isPlaying ? "Playing" : "Paused"}</span>
        {reducedMotion ? <span className="sr-only">Reduced motion enabled; image transitions are disabled. Playback starts only with Play.</span> : null}
      </div> : null}
      <button type="button" aria-label="Next image" aria-disabled={!hasNext || busy}
        onClick={() => { if (hasNext && !busy) navigate(index + 1); }}
        className={control + " absolute right-2 top-1/2 z-10 h-12 w-12 -translate-y-1/2 !px-0 text-2xl sm:right-5"}>›</button>
    </div>
  );
}
