"use client";

import { useEffect, useRef, useState } from "react";
import { imageUrl, Photo } from "../lib/api";
import { canInspectOriginal } from "../lib/photo-compare";

const buttonClass = "min-h-11 rounded-md border border-stone-300 px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50";

export default function CompareImage({ photo, side }: { photo: Photo; side: string }) {
  const preview = photo.resized_filename ? imageUrl("resized", photo.resized_filename) : photo.thumbnail_filename ? imageUrl("thumbs", photo.thumbnail_filename) : null;
  const [source, setSource] = useState(preview);
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const originalRequest = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const original = imageUrl("original", photo.stored_filename);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => { observer.disconnect(); if (originalRequest.current) { originalRequest.current.onload = null; originalRequest.current.onerror = null; } };
  }, []);
  const fit = natural.width && size.width ? Math.min(size.width / natural.width, size.height / natural.height) : 1;
  const width = natural.width * fit * zoom, height = natural.height * fit * zoom;
  function reset() { setZoom(1); viewport.current?.scrollTo({ left: 0, top: 0 }); }
  function pan(x: number, y: number) { viewport.current?.scrollBy({ left: x * size.width / 4, top: y * size.height / 4 }); }
  function loadOriginal() {
    if (originalLoading || source === original) return;
    setOriginalLoading(true); setNotice("");
    const image = new Image(); originalRequest.current = image;
    image.onload = () => { setSource(original); setNatural({ width: image.naturalWidth, height: image.naturalHeight }); setLoaded(true); setFailed(false); setOriginalLoading(false); setNotice("Original resolution loaded"); };
    image.onerror = () => { setOriginalLoading(false); setNotice("Original unavailable; showing preview."); };
    image.src = original;
  }
  return <div>
    <div ref={viewport} data-compare-viewport tabIndex={0} role="region" aria-label={`${side} photo image viewport`} className={`relative h-[min(55vh,600px)] min-h-56 overflow-auto rounded-lg bg-stone-100 focus-visible:outline-2 focus-visible:outline-emerald-700 ${zoom > 1 ? "cursor-grab touch-none" : ""}`}
      onPointerDown={(event) => {
        if (zoom <= 1 || event.button !== 0) return;
        const element = event.currentTarget;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
        element.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.id !== event.pointerId) return;
        event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
        event.currentTarget.scrollTop = start.top + start.y - event.clientY;
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {!source || failed ? <p role="status" className="flex h-full items-center justify-center">Image unavailable</p> : <div className="flex min-h-full min-w-full items-center justify-center" style={natural.width ? { width: Math.max(size.width, width), height: Math.max(size.height, height) } : undefined}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Local archive image endpoints bypass Next optimization. */}
        <img src={source} alt={`${side === "left" ? "Left" : "Right"} photo: ${photo.display_title || photo.original_filename}`} draggable={false} className="block shrink-0 object-contain" style={natural.width ? { width, height, maxWidth: "none" } : { maxWidth: "100%", maxHeight: "55vh" }}
          onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true); }}
          onError={() => {
            if (source === original && preview) { setSource(preview); setNotice("Original unavailable; showing preview."); }
            else setFailed(true);
          }} />
      </div>}
      {source && !loaded && !failed ? <p role="status" className="absolute inset-x-0 top-3 text-center text-sm">Loading image…</p> : null}
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" aria-label={`Zoom out ${side} photo`} disabled={!loaded || failed || zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.5))} className={buttonClass}>−</button>
      <span className="text-sm" aria-label={`${side} photo zoom`}>{zoom === 1 ? "Fit" : `${zoom}× fit`}</span>
      <button type="button" aria-label={`Zoom in ${side} photo`} disabled={!loaded || failed || zoom >= 4} onClick={() => setZoom((value) => Math.min(4, value + 0.5))} className={buttonClass}>+</button>
      <button type="button" aria-label={`Fit / reset ${side} photo`} onClick={reset} className={buttonClass}>Fit / reset</button>
      {canInspectOriginal(photo) ? <button type="button" aria-label={`Load ${side} photo original resolution`} disabled={originalLoading || source === original} onClick={loadOriginal} className={buttonClass}>{originalLoading ? "Loading original…" : source === original ? "Original loaded" : "Load original resolution"}</button> : <p className="text-xs text-stone-600">Original inspection is unavailable for this format; using the preview (up to 1600 px).</p>}
      {source === original && preview ? <button type="button" aria-label={`Use ${side} photo preview`} onClick={() => { setSource(preview); setNotice(""); }} className={buttonClass}>Use preview</button> : null}
    </div>
    {zoom > 1 ? <div className="mt-2 flex flex-wrap gap-2" aria-label={`${side} photo pan controls`}>
      {([ ["left", -1, 0], ["right", 1, 0], ["up", 0, -1], ["down", 0, 1] ] as const).map(([direction, x, y]) => <button type="button" key={direction} aria-label={`Pan ${side} photo ${direction}`} onClick={() => pan(x, y)} className={buttonClass}>Pan {direction}</button>)}
    </div> : null}
    <p role="status" className="mt-1 text-xs text-stone-600">{notice || (source === original ? "Original resolution" : "Preview resolution · zoom is relative to fit")}</p>
  </div>;
}
