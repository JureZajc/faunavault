"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PhotoCurationControls } from "../components/photo-detail/photo-curation";
import PhotoCurationSummary from "../components/photo-curation-summary";
import { useComparePhoto } from "../hooks/use-compare-photo";
import { PhotoRating, PhotoUpdate } from "../lib/api";
import { compareMetadata, compareReturnLocation, parseComparePair } from "../lib/photo-compare";
import CompareImage from "./compare-image";

type Side = "left" | "right";
const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-50";

export default function CompareBrowser() {
  const params = useSearchParams();
  const { pair, error } = parseComparePair(new URLSearchParams(params.toString()));
  const returnTo = compareReturnLocation(params.get("returnTo"));
  const label = returnTo.startsWith("/duplicates") ? "Back to duplicate review" : returnTo.startsWith("/cull") ? "Back to Culling" : "Back to List";
  const currentHref = `/compare?${params}`;
  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-[1600px] px-3 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-3xl font-semibold">Photo Compare</h1><p className="mt-2 text-sm text-stone-600">Two photos. Your decisions stay independent.</p></div>
        <Link href={returnTo} className={buttonClass + " inline-flex items-center"}>{label}</Link>
      </header>
      {returnTo.startsWith("/duplicates") ? <p className="mt-3 text-sm text-stone-600">Curation does not resolve this duplicate pair. Return to Duplicate Review for its evidence and Keep both / Trash actions.</p> : null}
      {pair ? <ComparePair key={`${pair.left}:${pair.right}`} leftId={pair.left} rightId={pair.right} currentHref={currentHref} /> : <section role="alert" className="mt-6 rounded-lg border border-stone-200 bg-white p-6"><h2 className="text-xl font-semibold">Cannot open comparison</h2><p className="mt-2">{error}</p></section>}
    </div>
  </main>;
}

function ComparePair({ leftId, rightId, currentHref }: { leftId: number; rightId: number; currentHref: string }) {
  const left = useComparePhoto(leftId), right = useComparePhoto(rightId);
  const [active, setActive] = useState<Side>("left");
  const leftRoot = useRef<HTMLElement>(null), rightRoot = useRef<HTMLElement>(null);
  function select(side: Side, focus = false) {
    setActive(side);
    // On narrow screens the destination is hidden until React commits the switch.
    if (focus) window.requestAnimationFrame(() => (side === "left" ? leftRoot : rightRoot).current?.focus());
  }
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || document.querySelector('[aria-modal="true"]')) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (target instanceof Element && target.closest('a, button, [data-compare-viewport]')) return;
        event.preventDefault(); select(event.key === "ArrowLeft" ? "left" : "right", true); return;
      }
      const focused = active === "left" ? left : right;
      if (!focused.photo || focused.loading || focused.busy || focused.stale || focused.unavailable) return;
      const key = event.key.toLowerCase();
      let values: PhotoUpdate;
      if (key === "p") values = { culling_state: "pick" };
      else if (key === "x") values = { culling_state: "reject" };
      else if (key === "u") values = { culling_state: null };
      else if (key === "f") values = { is_favorite: !focused.photo.is_favorite };
      else if (/^[1-5]$/.test(key)) values = { rating: Number(key) as PhotoRating };
      else if (key === "0") values = { rating: null };
      else return;
      event.preventDefault(); void focused.save(values);
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });
  return <>
    <div className="mt-5 flex flex-wrap items-center gap-2" aria-label="Comparison focus">
      {(["left", "right"] as const).map((side) => <button key={side} type="button" aria-pressed={active === side} onClick={() => select(side)} className={buttonClass + " aria-pressed:border-emerald-800 aria-pressed:bg-emerald-50"}>Focus {side} photo</button>)}
      <p role="status" className="text-sm text-stone-600">Active: {active} photo</p>
    </div>
    <p className="mt-3 text-xs leading-5 text-stone-600">Shortcuts: ← / → focus side · P Pick · X Reject · U Clear decision · F Favorite · 1–5 Rating · 0 Clear rating. Zoom panes use arrows to scroll.</p>
    <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-2">
      {([ ["left", left, right, leftRoot], ["right", right, left, rightRoot] ] as const).map(([side, detail, other, root]) => {
        const photo = detail.photo;
        const metadata = photo ? compareMetadata(photo) : [];
        const otherMetadata = other.photo ? compareMetadata(other.photo) : [];
        return <section key={side} ref={root} tabIndex={-1} aria-label={`${side === "left" ? "Left" : "Right"} photo`} onFocusCapture={() => setActive(side)} onPointerDownCapture={() => setActive(side)} className={`${active === side ? "block" : "hidden lg:block"} min-w-0 rounded-xl border ${active === side ? "border-emerald-700" : "border-stone-200"} bg-white p-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 sm:p-4`}>
          <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="text-lg font-semibold">{side === "left" ? "Left" : "Right"} photo</h2><button type="button" disabled={detail.busy || detail.refreshing} onClick={() => void detail.refresh()} className={buttonClass} aria-label={`Refresh ${side} photo`}>{detail.refreshing ? "Refreshing…" : "Refresh"}</button></div>
          {detail.error ? <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{detail.error} {detail.stale ? "State may be stale. Refresh before another action." : ""}</p> : null}
          {detail.loading ? <p role="status" className="mt-5">Loading {side} photo…</p> : detail.unavailable ? <p role="status" className="my-12">Photo no longer available. It may have been moved to Trash or deleted.</p> : photo ? <>
            <h3 className="mt-3 break-words text-xl font-semibold">{photo.display_title || photo.original_filename}</h3>
            <p className="mb-3 break-words text-sm text-stone-600">{photo.original_filename}</p>
            <CompareImage key={`${photo.id}:${photo.resized_filename}:${photo.stored_filename}`} photo={photo} side={side} />
            <div className="mt-3"><PhotoCurationSummary photo={photo} /></div>
            <PhotoCurationControls photo={photo} target={`${side} photo`} disabled={detail.stale || detail.unavailable} busy={detail.busy} notice={detail.notice} save={detail.save} />
            <dl className="mt-4 border-t border-stone-200 text-sm">
              {metadata.map(([label, value], index) => {
                const differs = otherMetadata.length > 0 && value !== otherMetadata[index][1];
                return <div key={label} className={`grid min-h-12 grid-cols-[7rem_minmax(0,1fr)] gap-2 border-b border-stone-100 py-3 ${differs ? "bg-stone-50" : ""}`}><dt className="text-stone-600">{label}</dt><dd className="break-words">{value}{differs ? <span className="ml-2 text-xs text-stone-500">Differs</span> : null}</dd></div>;
              })}
            </dl>
            <Link href={`/photos/${photo.id}?returnTo=${encodeURIComponent(currentHref)}`} className={buttonClass + " mt-4 inline-flex items-center"}>Open {side} photo detail</Link>
          </> : <p className="my-12">Photo could not be loaded. Use Refresh to retry.</p>}
        </section>;
      })}
    </div>
  </>;
}
