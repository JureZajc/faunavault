"use client";

import { useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "../hooks/use-modal-accessibility";
import {
  photoThumbnailUrl,
  VisualDuplicateCandidate,
} from "../lib/api";

type PossibleDuplicateReviewProps = {
  file: File;
  candidates: VisualDuplicateCandidate[];
  isSubmitting: boolean;
  error: string | null;
  onKeep: () => void;
  onCancel: () => void;
};

function candidateTitle(candidate: VisualDuplicateCandidate) {
  return (
    candidate.display_title ||
    candidate.common_name ||
    candidate.original_filename
  );
}

function candidateHref(candidate: VisualDuplicateCandidate) {
  return candidate.location === "catalog"
    ? `/photos/${candidate.photo_id}`
    : "/?view=trash";
}

function CandidateCard({
  candidate,
  compact = false,
}: {
  candidate: VisualDuplicateCandidate;
  compact?: boolean;
}) {
  return (
    <article
      className={
        compact
          ? "grid grid-cols-[5rem_1fr] gap-3 rounded-md border border-stone-200 p-3"
          : "overflow-hidden rounded-lg border border-stone-200 bg-white"
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoThumbnailUrl(candidate.photo_id)}
        alt={`Existing photo: ${candidateTitle(candidate)}`}
        className={
          compact
            ? "h-16 w-20 rounded object-cover"
            : "aspect-[4/3] w-full object-cover"
        }
      />
      <div className={compact ? "min-w-0" : "p-4"}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate font-semibold text-stone-950">
            {candidateTitle(candidate)}
          </h3>
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
            {candidate.location === "catalog" ? "Catalog" : "Trash"}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-stone-500">
          {candidate.original_filename}
        </p>
        {candidate.species_guess ? (
          <p className="mt-1 truncate text-xs text-stone-600">
            {candidate.species_guess}
          </p>
        ) : null}
        <a
          href={candidateHref(candidate)}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-block text-sm font-semibold text-emerald-800 underline"
        >
          {candidate.location === "catalog"
            ? "View existing photo"
            : "View Trash"}
        </a>
      </div>
    </article>
  );
}

export default function PossibleDuplicateReview({
  file,
  candidates,
  isSubmitting,
  error,
  onKeep,
  onCancel,
}: PossibleDuplicateReviewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const [previewUrl] = useState(() => URL.createObjectURL(file));
  const strongest = candidates[0];

  const { handleKeyDown } = useModalAccessibility({
    isOpen: Boolean(strongest),
    dialogRef,
    initialFocusRef: keepButtonRef,
    onClose: onCancel,
    isBusy: isSubmitting,
  });

  useEffect(() => {
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  if (!strongest) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/50 px-4 py-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="possible-duplicate-title"
        aria-describedby="possible-duplicate-description"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="w-full max-w-3xl rounded-xl bg-stone-50 p-5 shadow-2xl"
      >
        <h2 id="possible-duplicate-title" className="text-xl font-semibold">
          Possible duplicate
        </h2>
        <p
          id="possible-duplicate-description"
          className="mt-2 text-sm leading-6 text-stone-600"
        >
          This upload looks very similar to an existing photo. Compare them and
          choose whether to keep both.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <article className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={`Uploaded photo: ${file.name}`}
                className="aspect-[4/3] w-full object-cover"
              />
            ) : null}
            <div className="p-4">
              <h3 className="font-semibold">Uploaded photo</h3>
              <p className="mt-1 truncate text-xs text-stone-500">{file.name}</p>
            </div>
          </article>
          <CandidateCard candidate={strongest} />
        </div>

        {candidates.length > 1 ? (
          <section className="mt-5" aria-labelledby="other-candidates-title">
            <h3
              id="other-candidates-title"
              className="text-sm font-semibold text-stone-800"
            >
              Other similar photos
            </h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {candidates.slice(1, 3).map((candidate) => (
                <CandidateCard
                  key={candidate.photo_id}
                  candidate={candidate}
                  compact
                />
              ))}
            </div>
          </section>
        ) : null}

        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-800 disabled:opacity-50"
          >
            Cancel upload
          </button>
          <button
            ref={keepButtonRef}
            type="button"
            onClick={onKeep}
            disabled={isSubmitting}
            className="min-h-11 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white disabled:bg-stone-300"
          >
            {isSubmitting ? "Keeping both photos" : "Keep both"}
          </button>
        </div>
      </div>
    </div>
  );
}
