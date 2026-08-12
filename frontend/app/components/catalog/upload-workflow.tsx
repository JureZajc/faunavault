"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef } from "react";
import PossibleDuplicateReview from "../possible-duplicate-review";
import { usePhotoUpload } from "../../hooks/use-photo-upload";

type UploadWorkflowProps = {
  refreshCatalog: () => Promise<unknown>;
  onError: (message: string | null) => void;
  returnTo: string;
  onViewTrash: () => void;
};

export default function UploadWorkflow({
  refreshCatalog,
  onError,
  returnTo,
  onViewTrash,
}: UploadWorkflowProps) {
  const uploadButtonRef = useRef<HTMLButtonElement>(null);
  const focusTimer = useRef<number | null>(null);
  const focusUploadTrigger = useCallback(() => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      focusTimer.current = null;
      uploadButtonRef.current?.focus();
    }, 0);
  }, []);
  const upload = usePhotoUpload({
    refreshCatalog,
    onError,
    onQueueDrained: focusUploadTrigger,
  });

  useEffect(() => {
    return () => {
      if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void upload.submit(event.currentTarget);
  }

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="rounded-lg border border-stone-200 bg-stone-50 p-4 shadow-sm"
      >
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Add to collection
          </span>
          <span className="mt-2 flex min-h-12 cursor-pointer items-center rounded-md border border-dashed border-stone-300 bg-white px-3 text-sm text-stone-600 transition hover:border-emerald-500">
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              onChange={(event) =>
                upload.selectFiles(Array.from(event.target.files ?? []))
              }
              multiple
              disabled={upload.hasPendingReviews}
              className="sr-only"
            />
            <span className="truncate">{upload.selectedFileLabel}</span>
          </span>
        </label>
        {upload.selectedFiles.length > 0 ? (
          <p className="mt-2 text-xs text-stone-500">
            {upload.selectedFiles.length}{" "}
            {upload.selectedFiles.length === 1 ? "file" : "files"} ready to
            upload.
          </p>
        ) : null}
        <button
          ref={uploadButtonRef}
          type="submit"
          disabled={
            upload.selectedFiles.length === 0 ||
            upload.isUploading ||
            upload.hasPendingReviews
          }
          className="mt-3 min-h-11 w-full rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {upload.isUploading
            ? `Uploading ${upload.selectedFiles.length} ${upload.selectedFiles.length === 1 ? "photo" : "photos"}`
            : upload.selectedFiles.length > 1
              ? "Upload photos"
              : "Upload photo"}
        </button>
        {upload.notice ? (
          <div
            className={`mt-3 rounded-md border px-3 py-2 text-sm ${
              upload.notice.kind === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
          >
            <p>{upload.notice.message}</p>
            {upload.notice.duplicateLocation === "catalog" &&
            upload.notice.duplicatePhotoId ? (
              <Link
                href={`/photos/${upload.notice.duplicatePhotoId}?returnTo=${encodeURIComponent(returnTo)}`}
                className="mt-2 inline-block font-semibold underline"
              >
                View existing photo
              </Link>
            ) : upload.notice.duplicateLocation === "trash" ? (
              <button
                type="button"
                onClick={onViewTrash}
                className="mt-2 font-semibold underline"
              >
                View Trash
              </button>
            ) : null}
          </div>
        ) : null}
      </form>
      {upload.currentReview ? (
        <PossibleDuplicateReview
          key={upload.currentReview.reviewId}
          file={upload.currentReview.file}
          candidates={upload.currentReview.candidates}
          isSubmitting={upload.isConfirmingReview}
          error={upload.reviewError}
          onKeep={() => void upload.keepCurrentReview()}
          onCancel={upload.cancelCurrentReview}
        />
      ) : null}
    </>
  );
}
