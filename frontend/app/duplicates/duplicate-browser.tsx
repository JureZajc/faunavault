"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import MoveToTrashButton from "../components/move-to-trash-button";
import PhotoCurationSummary from "../components/photo-curation-summary";
import PhotoMedia from "../components/photo-detail/photo-media";
import { PhotoMetadataDetails } from "../components/photo-detail/photo-metadata";
import { dismissDuplicate, DuplicateIdentity, DuplicateReview, DuplicateSummary, getDuplicateReview, getDuplicateSummary, Photo } from "../lib/api";

function href(pair: DuplicateIdentity | null) {
  return pair ? `/duplicates?left=${pair.left}&right=${pair.right}` : "/duplicates";
}
function parseId(value: string | null) {
  const id = value && /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
  return id && Number.isSafeInteger(id) ? id : undefined;
}
const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold disabled:opacity-40";

export default function DuplicateBrowser() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const params = useSearchParams();
  const left = parseId(params.get("left"));
  const right = parseId(params.get("right"));
  const [review, setReview] = useState<DuplicateReview | null>(null);
  const [summary, setSummary] = useState<DuplicateSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const guard = useRef(false);
  const sequence = useRef(0);

  const load = useCallback(async (selected?: DuplicateIdentity, signal?: AbortSignal) => {
    const operation = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const [next, counts] = await Promise.all([getDuplicateReview(selected, signal), getDuplicateSummary(signal)]);
      if (signal?.aborted || operation !== sequence.current) return;
      setReview(next);
      setSummary(counts);
      if (next.requested_pair_unavailable) setNotice("That pair no longer needs review. Showing the next available pair.");
      if (!selected || next.requested_pair_unavailable) routerRef.current.replace(href(next.pair?.identity ?? null), { scroll: false });
    } catch (failure) {
      if (!signal?.aborted && operation === sequence.current) {
        setReview(null);
        setError(failure instanceof Error ? failure.message : "Could not load duplicate review.");
      }
    } finally {
      if (!signal?.aborted && operation === sequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const selected = left && right && left < right ? { left, right } : undefined;
    const timer = window.setTimeout(() => { void load(selected, controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [left, right, load]);

  useEffect(() => {
    const refresh = () => {
      if (!guard.current && document.visibilityState === "visible") void load(left && right && left < right ? { left, right } : undefined);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [left, right, load]);

  function moveTo(pair: DuplicateIdentity | null) {
    if (!pair || guard.current || loading) return;
    setNotice(null);
    routerRef.current.push(href(pair), { scroll: false });
  }
  function skip() {
    if (guard.current || loading || !review) return;
    if (review.total <= 1) setNotice("This is the only unresolved pair. Skip leaves it unresolved.");
    else moveTo(review.next ?? review.first);
  }
  async function keepBoth() {
    if (guard.current || loading || !review?.pair) return;
    guard.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await dismissDuplicate(review.pair);
      setNotice("Kept both photos. This pair has been reviewed.");
      setReview(null);
      routerRef.current.replace(href(result.next), { scroll: false });
      await load(result.next ?? undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not keep both photos.");
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function dialogBusy(value: boolean) {
    guard.current = value;
    setBusy(value);
  }
  async function trashed(photo: Photo) {
    setNotice(`Moved ${photo.original_filename} to Trash. Restore it from Trash if needed.`);
    const selected = review?.next ?? review?.previous ?? null;
    setReview(null);
    routerRef.current.replace(href(selected), { scroll: false });
    await load(selected ?? undefined);
  }
  const pair = review?.pair;

  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <ArchiveNavigation active="duplicates" />
      <header className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">Archive curation</p><h1 className="mt-2 text-3xl font-semibold">Duplicate Review Center</h1></div>
        {review ? <p role="status" className="text-sm text-stone-600">{review.total} possible pairs remaining</p> : null}
      </header>
      <p className="mt-3 text-sm text-stone-600">Compare each pair before deciding. Visual similarity is a review hint; it does not prove that photos are duplicates. Identical originals are blocked during ingestion, including copies in Trash.</p>
      {summary ? <section aria-label="Discovery coverage" className="mt-5 rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-600">
        <p>{summary.dismissed} pairs explicitly reviewed · detector {summary.detector}</p>
        {!summary.scan ? <p className="mt-2">A full archive scan has not been run. Matches detected during ingestion may already appear here.</p> : summary.scan.status === "incomplete" ? <p className="mt-2 text-amber-800">Archive scan incomplete: {summary.scan.reason || "interrupted"}. Discovered pairs remain available for review.</p> : <p className="mt-2">Last completed scan: {new Date(summary.scan.completed_at!).toLocaleString()} · {summary.scan.processed} photos processed, {summary.scan.skipped} skipped.</p>}
        {summary.scan?.status === "incomplete" && summary.scan.last_successful_at ? <p>Previous completed scan: {new Date(summary.scan.last_successful_at).toLocaleString()}.</p> : null}
        {summary.missing_fingerprints > 0 ? <p className="mt-2">{summary.missing_fingerprints} photos have no fingerprint and could not be assessed.</p> : null}
        <p className="mt-2">For full archive coverage, stop the backend and importer and run the local duplicate scan described in Operations. New uploads and fingerprint backfills may require another scan.</p>
      </section> : null}
      {notice ? <p role="status" className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p> : null}
      {error ? <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" disabled={busy || loading} onClick={() => void load(left && right && left < right ? { left, right } : undefined)} className="ml-3 font-semibold underline disabled:opacity-40">Retry</button></div> : null}
      {loading ? <p role="status" className="mt-8 text-stone-600">Loading comparison…</p> : pair ? <>
        <section aria-label="Pair review actions" className="mt-6 flex flex-wrap items-center gap-3">
          <p className="mr-auto text-sm font-medium">Fingerprint distance {pair.distance}; review threshold {summary?.threshold ?? 4}</p>
          <button type="button" className={buttonClass} disabled={busy || !review.previous} onClick={() => moveTo(review.previous)}>← Previous</button>
          <button type="button" className={buttonClass} disabled={busy || !review.next} onClick={() => moveTo(review.next)}>Next →</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={skip}>Skip</button>
          <button type="button" className="min-h-11 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white disabled:bg-stone-300" disabled={busy} onClick={() => void keepBoth()}>Keep both / Not duplicates</button>
        </section>
        <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-2">
          {([ ["Left", pair.left_photo], ["Right", pair.right_photo] ] as const).map(([side, photo]) => <section key={`${side}-${photo.id}`} aria-label={`${side} photo`} className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">{side} photo</h2><div className="flex flex-wrap gap-2">
              <Link aria-disabled={busy} tabIndex={busy ? -1 : undefined} onClick={(event) => { if (guard.current) event.preventDefault(); }} href={`/photos/${photo.id}?returnTo=${encodeURIComponent(href(pair.identity))}`} className={buttonClass + " inline-flex items-center"}>Open {side.toLowerCase()} photo</Link>
              <MoveToTrashButton photo={photo} label={`Move ${side.toLowerCase()} photo to Trash`} disabled={busy || loading} onBusyChange={dialogBusy} onMoved={trashed} className={buttonClass + " text-red-700"} />
            </div></div>
            <PhotoMedia photo={photo} />
            <div className="mt-3 rounded-lg border border-stone-200 bg-white p-4"><p className="text-sm text-stone-600">Original size: {photo.original_size_bytes === null ? "Not available" : `${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(photo.original_size_bytes / 1024 / 1024)} MB`} · Active archive</p><PhotoCurationSummary photo={photo} /><PhotoMetadataDetails photo={photo} /></div>
          </section>)}
        </div>
      </> : !error ? <section className="mt-8 rounded-lg border border-stone-200 bg-white p-6"><h2 className="text-xl font-semibold">No possible duplicates need review.</h2><p className="mt-2 text-sm text-stone-600">This reflects discovered candidates under the configured rules and scan coverage above.</p></section> : null}
    </div>
  </main>;
}
