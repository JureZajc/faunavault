"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import ClassificationJobsPanel from "../components/classification-jobs-panel";
import PhotoAnimalSection from "../components/photo-detail/photo-animal-section";
import PhotoMedia from "../components/photo-detail/photo-media";
import {
  confidenceLabel,
  PhotoMetadataDetails,
  PhotoMetadataEditor,
} from "../components/photo-detail/photo-metadata";
import { useClassificationJobs } from "../hooks/use-classification-jobs";
import {
  acceptReview,
  classifyPhoto,
  getReviewInbox,
  Photo,
  ReviewInbox,
} from "../lib/api";

function reviewHref(photoId: number | null) {
  return photoId === null ? "/review" : `/review?photo=${photoId}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(
    target.closest('input, textarea, select, button, a, [contenteditable="true"]'),
  );
}

export default function ReviewBrowser() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);
  const searchParams = useSearchParams();
  const requestedPhoto = searchParams.get("photo");
  const parsedId = requestedPhoto && /^[1-9]\d*$/.test(requestedPhoto)
    ? Number(requestedPhoto)
    : undefined;
  const requestedId = parsedId !== undefined && Number.isSafeInteger(parsedId)
    ? parsedId : undefined;
  const [inbox, setInbox] = useState<ReviewInbox | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingVersion, setEditingVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const photo = inbox?.photo ?? null;

  const reload = useCallback(async () => {
    const next = await getReviewInbox(requestedId);
    setInbox(next);
    if (next.requested_photo_unavailable) {
      setNotice("That photo is no longer in the Review Inbox.");
      routerRef.current.replace(reviewHref(next.photo?.id ?? null), { scroll: false });
    }
    return next;
  }, [requestedId]);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") void reload().catch(() => undefined);
    };
    const timer = window.setInterval(check, 10000);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setIsLoading(true);
      setError(null);
      getReviewInbox(requestedId, controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setInbox(next);
          setIsEditing(false);
          setEditingVersion(null);
          if (next.requested_photo_unavailable) {
            setNotice("That photo is no longer in the Review Inbox.");
            routerRef.current.replace(reviewHref(next.photo?.id ?? null), { scroll: false });
          } else if ((!requestedPhoto || requestedId === undefined) && next.photo) {
            routerRef.current.replace(reviewHref(next.photo.id), { scroll: false });
          }
        })
        .catch((nextError: unknown) => {
          if (!controller.signal.aborted) {
            setError(errorMessage(nextError, "Could not load the Review Inbox."));
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [requestedId, requestedPhoto]);

  const jobs = useClassificationJobs({
    photoId: photo?.id ?? -1,
    onSucceeded: async () => { await reload(); },
  });
  const successfulJob = useMemo(
    () => jobs.jobs.find((job) => job.photo_id === photo?.id && job.status === "succeeded"),
    [jobs.jobs, photo?.id],
  );
  const visibleJobs = useMemo(
    () => jobs.jobs.filter((job) => job.photo_id === photo?.id),
    [jobs.jobs, photo?.id],
  );
  const activeJob = visibleJobs.some((job) => job.status === "queued" || job.status === "running");

  const moveTo = useCallback((id: number, replace = false) => {
    setError(null);
    setNotice(null);
    if (replace) routerRef.current.replace(reviewHref(id), { scroll: false });
    else routerRef.current.push(reviewHref(id), { scroll: false });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        isEditing || isBusy || event.altKey || event.ctrlKey || event.metaKey ||
        isTypingTarget(event.target) || document.querySelector('[aria-modal="true"]')
      ) return;
      const destination = event.key === "ArrowLeft"
        ? inbox?.previous_photo_id
        : event.key === "ArrowRight"
          ? inbox?.next_photo_id
          : null;
      if (destination !== null && destination !== undefined) {
        event.preventDefault();
        moveTo(destination);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inbox, isBusy, isEditing, moveTo]);

  async function skip() {
    if (!inbox || !photo) return;
    if (inbox.next_photo_id !== null) {
      moveTo(inbox.next_photo_id);
      return;
    }
    try {
      const first = await getReviewInbox();
      if (first.photo && first.photo.id !== photo.id) moveTo(first.photo.id);
    } catch (nextError) {
      setError(errorMessage(nextError, "Could not move to the next photo."));
    }
  }

  async function accept() {
    if (!photo) return;
    setIsBusy(true);
    setError(null);
    try {
      const response = await acceptReview(photo.id, photo.updated_at);
      setInbox(null);
      routerRef.current.replace(reviewHref(response.next_photo_id), { scroll: false });
      setNotice("Classification accepted.");
    } catch (nextError) {
      setError(errorMessage(nextError, "Could not accept this classification."));
      await reload().catch(() => undefined);
    } finally {
      setIsBusy(false);
    }
  }

  function onSaved(updated: Photo) {
    setIsEditing(false);
    setEditingVersion(null);
    if (updated.status === "classified" && photo?.status === "needs_review") {
      setInbox(null);
      routerRef.current.replace(reviewHref(inbox?.next_photo_id ?? null), { scroll: false });
      setNotice("Metadata saved and review completed.");
    } else {
      setInbox((current) => current ? { ...current, photo: updated } : current);
      setNotice("No metadata change was saved. Use Accept to confirm the result.");
    }
  }

  async function reclassify() {
    if (!photo) return;
    setError(null);
    try {
      jobs.acceptEnqueue(await classifyPhoto(photo.id));
      setNotice("Classification queued.");
    } catch (nextError) {
      setError(errorMessage(nextError, "Could not queue classification."));
    }
  }

  async function retry(jobId: number) {
    setError(null);
    try {
      await jobs.retry(jobId);
    } catch (nextError) {
      setError(errorMessage(nextError, "Could not retry classification."));
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
        <ArchiveNavigation active="review" />
        <header className="mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">Archive workflow</p>
            <h1 className="mt-2 text-3xl font-semibold">AI Review Inbox</h1>
          </div>
          {inbox && inbox.total > 0 ? (
            <p role="status" className="text-sm font-medium text-stone-600">
              {inbox.position} of {inbox.total} · {inbox.total} remaining
            </p>
          ) : null}
        </header>

        {notice ? <p role="status" className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{notice}</p> : null}
        {error ? <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}<button type="button" onClick={() => void reload().catch((nextError) => setError(errorMessage(nextError, "Could not load the Review Inbox.")))} className="ml-3 font-semibold underline">Retry</button></div> : null}

        {isLoading || (inbox === null && !error) ? (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]" aria-label="Loading review item">
            <div className="aspect-[4/3] animate-pulse rounded-lg bg-stone-200" />
            <div className="h-96 animate-pulse rounded-lg bg-white" />
          </div>
        ) : photo && inbox ? (
          <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <PhotoMedia key={photo.id} photo={photo} />
            <aside className="min-w-0 self-start rounded-lg border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="break-words text-xl font-semibold">{photo.display_title || photo.original_filename}</h2>
              <p className="mt-2 text-sm text-amber-800">
                {inbox.low_confidence
                  ? `Low confidence (${confidenceLabel(photo.confidence)}) requires review.`
                  : "AI flagged this classification for review."}
              </p>
              {successfulJob ? (
                <p className="mt-2 break-words text-xs text-stone-500">
                  Classified with {successfulJob.actual_model ?? successfulJob.requested_model} · prompt {successfulJob.prompt_version}
                </p>
              ) : null}
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => moveTo(inbox.previous_photo_id!)} disabled={inbox.previous_photo_id === null || isBusy} className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold disabled:opacity-40">← Previous</button>
                <button type="button" onClick={() => moveTo(inbox.next_photo_id!)} disabled={inbox.next_photo_id === null || isBusy} className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold disabled:opacity-40">Next →</button>
              </div>
              <p className="mt-2 text-xs text-stone-500">Use Left and Right arrow keys to navigate.</p>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => void accept()} disabled={isBusy || activeJob || isEditing} className="min-h-11 rounded-md bg-emerald-800 px-3 text-sm font-semibold text-white disabled:bg-stone-300">{isBusy ? "Accepting…" : "Accept"}</button>
                <button type="button" onClick={() => { setEditingVersion(photo.updated_at); setIsEditing(true); }} disabled={isBusy || isEditing} className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold disabled:opacity-40">Edit</button>
                <button type="button" onClick={() => void reclassify()} disabled={isBusy || activeJob || isEditing} className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold disabled:opacity-40">Reclassify</button>
                <button type="button" onClick={() => void skip()} disabled={isBusy || isEditing} className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold disabled:opacity-40">Skip</button>
              </div>
              {jobs.error ? <p role="alert" className="mt-3 text-sm text-red-700">{jobs.error}</p> : null}
              <ClassificationJobsPanel jobs={visibleJobs} photos={[photo]} onRetry={retry} />
              {isEditing ? (
                <PhotoMetadataEditor key={photo.id} photo={photo} expectedUpdatedAt={editingVersion ?? photo.updated_at} onSaved={onSaved} onCancel={() => { setEditingVersion(null); setIsEditing(false); }} onBusyChange={setIsBusy} onError={setError} />
              ) : (
                <>
                  <PhotoMetadataDetails photo={photo} />
                  {photo.animal_id ? <PhotoAnimalSection animalId={photo.animal_id} /> : null}
                </>
              )}
            </aside>
          </div>
        ) : !error ? (
          <section className="mt-8 rounded-xl border border-emerald-200 bg-white px-6 py-16 text-center shadow-sm">
            <h2 className="text-2xl font-semibold">All caught up</h2>
            <p className="mt-2 text-stone-600">There are no photos left to review.</p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
