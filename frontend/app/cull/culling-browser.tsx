"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import CullingDecisionControls, { cullingLabel } from "../components/photo-detail/culling-decision-controls";
import PhotoMedia from "../components/photo-detail/photo-media";
import { PhotoMetadataDetails } from "../components/photo-detail/photo-metadata";
import PhotoCurationSummary from "../components/photo-curation-summary";
import { ApiError, CullingWorkspace, getCullingWorkspace, PhotoCullingState, updatePhoto } from "../lib/api";
import { parseCatalogState } from "../lib/catalog-query";
import { compareHref } from "../lib/photo-compare";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Please try again.";
}

function safeListReturn(value: string | null) {
  // Culling's return destination is the List view on this application.
  return value?.startsWith("/?") && !/[\\\u0000-\u001f]/.test(value) ? value : "/";
}

export default function CullingBrowser() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const params = useSearchParams();
  const paramsString = params.toString();
  const source = params.get("source") === "list" ? "list" : "undecided";
  const queryKey = JSON.stringify({ ...parseCatalogState(new URLSearchParams(paramsString)), page: 1, layout: "flat", ...(source === "undecided" ? { culling_state: "undecided" } : {}) });
  const query = useMemo(() => JSON.parse(queryKey) as ReturnType<typeof parseCatalogState>, [queryKey]);
  const photoParam = params.get("photo");
  const requestedId = photoParam && /^[1-9]\d*$/.test(photoParam) && Number.isSafeInteger(Number(photoParam)) ? Number(photoParam) : undefined;
  const context = `${source}:${queryKey}`;
  const location = `${context}:${requestedId ?? ""}`;
  const latestLocation = useRef(location);
  const [workspace, setWorkspace] = useState<CullingWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [retryDecision, setRetryDecision] = useState<{ id: number; state: PhotoCullingState | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [decided, setDecided] = useState<Set<number>>(() => new Set());
  const history = useRef<number[]>([]);
  const cursor = useRef(-1);
  const [historyNeighbors, setHistoryNeighbors] = useState<{ previous: number | null; next: number | null }>({ previous: null, next: null });
  const request = useRef(0);
  const root = useRef<HTMLElement>(null);
  const historyContext = useRef(context);
  const photo = workspace?.photo ?? null;

  const moveTo = useCallback((id?: number, replace = false, preserveNotice = false) => {
    if (!preserveNotice) setNotice(null);
    const next = new URLSearchParams(paramsString);
    if (id === undefined) next.delete("photo"); else next.set("photo", String(id));
    const href = next.size ? `/cull?${next}` : "/cull";
    if (replace) routerRef.current.replace(href, { scroll: false });
    else routerRef.current.push(href, { scroll: false });
  }, [paramsString]);

  function remember(next: CullingWorkspace) {
    if (!next.photo) return;
    const index = history.current.indexOf(next.photo.id);
    if (index >= 0) cursor.current = index;
    else {
      history.current = [...history.current.slice(0, cursor.current + 1), next.photo.id];
      cursor.current = history.current.length - 1;
    }
    setHistoryNeighbors({ previous: history.current[cursor.current - 1] ?? null, next: history.current[cursor.current + 1] ?? null });
  }

  const reload = useCallback(async () => {
    const token = ++request.current;
    let next: CullingWorkspace;
    try {
      next = await getCullingWorkspace(query, requestedId);
    } catch (failure) {
      if (token !== request.current) return;
      throw failure;
    }
    if (token !== request.current) return;
    setWorkspace(next);
    setError(null);
    remember(next);
    if (next.requested_photo_unavailable) {
      setNotice("That photo is no longer available in this source.");
      moveTo(next.photo?.id, true, true);
    }
    return next;
  }, [query, requestedId, moveTo]);

  useEffect(() => {
    latestLocation.current = location;
    const token = ++request.current;
    const controller = new AbortController();
    const requestCounter = request;
    const timer = window.setTimeout(() => {
      if (historyContext.current !== context) {
        historyContext.current = context;
        history.current = []; cursor.current = -1;
        setHistoryNeighbors({ previous: null, next: null });
        setDecided(new Set()); setNotice(null);
      }
      setLoading(true); setError(null); setRetryDecision(null); setWorkspace(null);
      getCullingWorkspace(query, requestedId, controller.signal).then((next) => {
        if (controller.signal.aborted || token !== request.current) return;
        remember(next); setWorkspace(next);
        if (next.requested_photo_unavailable) {
          setNotice("That photo is no longer available in this source.");
          moveTo(next.photo?.id, true, true);
        } else if (requestedId === undefined && next.photo) moveTo(next.photo.id, true, true);
      }).catch((failure) => {
        if (!controller.signal.aborted && token === request.current) setError(`Could not load Culling: ${message(failure)}`);
      }).finally(() => { if (token === request.current) setLoading(false); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); requestCounter.current++; };
  }, [context, location, query, requestedId, moveTo]);

  const previousId = historyNeighbors.previous ?? workspace?.previous_photo_id ?? null;
  const nextId = historyNeighbors.next ?? workspace?.next_photo_id ?? null;

  async function save(state: PhotoCullingState | null) {
    if (!photo || loading || saving.current) return;
    if (state === null && photo.culling_state == null) return;
    request.current++; // A refresh started before this save cannot replace its confirmed state.
    saving.current = true; setBusy(true); setError(null); setRetryDecision(null); setNotice(null);
    const startedAt = latestLocation.current;
    let confirmed = false;
    try {
      const saved = await updatePhoto(photo.id, { culling_state: state }, photo.updated_at);
      if (latestLocation.current !== startedAt) return;
      confirmed = true;
      setWorkspace((current) => current ? { ...current, photo: saved } : current);
      setDecided((current) => {
        const next = new Set(current);
        if (state === null) next.delete(saved.id); else next.add(saved.id);
        return next;
      });
      const refreshed = await getCullingWorkspace(query, saved.id);
      if (latestLocation.current !== startedAt) return;
      setWorkspace(refreshed);
      setNotice(`Saved: ${cullingLabel(state)}.${state !== null && !refreshed.next_photo_id && history.current[cursor.current + 1] === undefined ? " End of pass." : ""}`);
      const destination = history.current[cursor.current + 1] ?? refreshed.next_photo_id;
      if (state !== null && destination !== null && destination !== undefined) moveTo(destination);
      root.current?.focus();
    } catch (failure) {
      if (latestLocation.current !== startedAt) return;
      setError(confirmed ? `Decision saved, but the queue could not refresh: ${message(failure)}` : `Could not save culling decision: ${message(failure)}`);
      if (!confirmed && !(failure instanceof ApiError && failure.status === 409)) setRetryDecision({ id: photo.id, state });
      if (failure instanceof ApiError && failure.status === 409) {
        const next = await getCullingWorkspace(query, photo.id).catch(() => null);
        if (next && latestLocation.current === startedAt) setWorkspace(next);
      }
    } finally {
      saving.current = false; setBusy(false);
    }
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (loading || saving.current || !photo || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || document.querySelector('[aria-modal="true"]')) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.key.startsWith("Arrow") && target instanceof Element && target.closest("a, button")) return;
      const key = event.key.toLowerCase();
      if (["p", "x", "u"].includes(key)) {
        event.preventDefault(); void save(key === "p" ? "pick" : key === "x" ? "reject" : null);
      } else if (event.key === "ArrowLeft" && previousId !== null) { event.preventDefault(); moveTo(previousId); }
      else if (event.key === "ArrowRight" && nextId !== null) { event.preventDefault(); moveTo(nextId); }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  function restart() {
    if (saving.current) return;
    history.current = []; cursor.current = -1; setDecided(new Set()); setNotice(null);
    setHistoryNeighbors({ previous: null, next: null });
    if (requestedId === undefined) void reload().catch((failure) => setError(message(failure)));
    else moveTo();
  }

  const currentHref = `/cull${paramsString ? `?${paramsString}` : ""}`;
  const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold disabled:opacity-50";
  return <main ref={root} tabIndex={-1} className="min-h-screen bg-[#f7f8f4] text-stone-950 outline-none">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <ArchiveNavigation active="cull" onNavigate={(_section, event) => { if (saving.current) event.preventDefault(); }} />
      <header className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-semibold">Photo Culling</h1><p className="mt-2 text-sm text-stone-600">{source === "list" ? "Current List query" : "Active undecided photos"} · Pick selects; Reject keeps the photo in your archive.</p></div>
        <Link href={safeListReturn(params.get("returnTo"))} aria-disabled={busy} onClick={(event) => { if (saving.current) event.preventDefault(); }} className={buttonClass + " inline-flex items-center"}>Back to List</Link>
      </header>
      <p role="status" className="mt-4 text-sm text-stone-600">{workspace?.total ?? 0} matching photos · {decided.size} decisions this session</p>
      {notice ? <p role="status" className="mt-3 text-sm text-emerald-900">{notice}</p> : null}
      {error ? <div role="alert" className="mt-4 rounded-lg bg-red-50 p-4 text-red-800">{error}{retryDecision && retryDecision.id === photo?.id ? <button type="button" disabled={busy || loading} onClick={() => void save(retryDecision.state)} className="ml-3 min-h-11 underline">Retry decision</button> : null}<button type="button" disabled={busy || loading} onClick={() => void reload().catch((failure) => setError(message(failure)))} className="ml-3 min-h-11 underline">Refresh / Retry</button></div> : null}
      {loading ? <p className="mt-6" aria-label="Loading culling photo">Loading photo…</p> : photo ? <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 self-start"><PhotoMedia key={photo.id} photo={photo} /></div>
        <aside className="min-w-0 self-start rounded-lg border border-stone-200 bg-white p-4 shadow-sm sm:p-5" aria-busy={busy}>
          <h2 className="break-words text-xl font-semibold">{photo.display_title || photo.original_filename}</h2>
          <p className="mt-1 break-words text-sm text-stone-600">{photo.original_filename} · {photo.species_guess || "Species not identified"}</p>
          <div className="mt-3"><PhotoCurationSummary photo={photo} /></div>
          <CullingDecisionControls state={photo.culling_state} disabled={busy} shortcuts onChange={(state) => void save(state)} />
          <p role="status" className="mt-2 text-sm text-stone-600">{busy ? "Saving…" : "Pick and Reject advance after saving. Clear stays here."}</p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy || previousId === null} onClick={() => previousId !== null && moveTo(previousId)} className={buttonClass}>← Previous</button>
            <button type="button" disabled={busy || nextId === null} onClick={() => nextId !== null && moveTo(nextId)} className={buttonClass}>Next →</button>
          </div>
          <p className="mt-2 text-xs text-stone-600">P = Pick · X = Reject · U = Clear · arrows = navigation</p>
          {nextId === null ? <p role="status" className="mt-3 text-sm font-medium">End of pass · {workspace?.total ?? 0} still match this source.</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {nextId !== null || previousId !== null ? <Link href={compareHref(photo.id, (nextId ?? previousId)!, currentHref)} aria-disabled={busy} tabIndex={busy ? -1 : undefined} onClick={(event) => { if (saving.current) event.preventDefault(); }} className={buttonClass + " inline-flex items-center"}>Compare with {nextId !== null ? "next" : "previous"}</Link> : <button type="button" disabled className={buttonClass}>Compare · no neighbor</button>}
            <button type="button" disabled={busy} onClick={restart} className={buttonClass}>Restart</button>
            <Link href={`/photos/${photo.id}?returnTo=${encodeURIComponent(currentHref)}`} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }} className={buttonClass + " inline-flex items-center"}>Open Photo detail</Link>
          </div>
          <p className="mt-4 text-xs text-stone-600">Favorite and Rating are independent. Change them in Photo detail. Session history resets when you reload or leave Culling.</p>
          <PhotoMetadataDetails photo={photo} />
        </aside>
      </div> : !error ? <section className="mt-8 rounded-lg bg-white p-12 text-center"><h2 className="text-2xl font-semibold">No photos to cull</h2><p className="mt-2 text-stone-600">No active photos match this source.</p><button type="button" onClick={restart} className={buttonClass + " mt-4"}>Restart</button></section> : null}
    </div>
  </main>;
}
