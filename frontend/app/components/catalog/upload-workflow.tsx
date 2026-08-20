"use client";

import { FormEvent, useCallback, useEffect, useRef } from "react";
import PossibleDuplicateReview from "../possible-duplicate-review";
import { usePhotoUpload } from "../../hooks/use-photo-upload";
import UploadProgressList from "./upload-progress-list";

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusTimer = useRef<number | null>(null);
  const focusFilePicker = useCallback(() => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      focusTimer.current = null;
      fileInputRef.current?.focus();
    }, 0);
  }, []);
  const upload = usePhotoUpload({
    refreshCatalog,
    onError,
    onQueueDrained: focusFilePicker,
  });

  useEffect(() => {
    return () => {
      if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void upload.actions.submit(event.currentTarget);
  }

  const selectedCount = upload.state.isSelectionReady
    ? upload.state.summary.total
    : 0;

  return (
    <>
      <form
        onSubmit={handleSubmit}
        className="min-w-0 rounded-lg border border-stone-200 bg-stone-50 p-4 shadow-sm"
      >
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Add to collection
          </span>
          <span className="mt-2 flex min-h-12 cursor-pointer items-center rounded-md border border-dashed border-stone-300 bg-white px-3 text-sm text-stone-600 transition hover:border-emerald-500 focus-within:border-emerald-700 focus-within:ring-2 focus-within:ring-emerald-700/20 has-[:disabled]:cursor-not-allowed has-[:disabled]:bg-stone-100">
            <input
              ref={fileInputRef}
              type="file"
              accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
              onChange={(event) =>
                upload.actions.selectFiles(Array.from(event.target.files ?? []))
              }
              multiple
              disabled={upload.state.isQueueActive}
              className="sr-only"
            />
            <span
              title={upload.state.selectedFileLabel}
              className="min-w-0 truncate"
            >
              {upload.state.selectedFileLabel}
            </span>
          </span>
        </label>
        {selectedCount > 0 ? (
          <p className="mt-2 text-xs text-stone-500">
            {selectedCount} {selectedCount === 1 ? "file" : "files"} ready to
            upload.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={!upload.state.canSubmit}
          className="mt-3 min-h-11 w-full rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {upload.state.isQueueActive
            ? upload.state.isProcessing
              ? "Uploading photos"
              : "Review uploads"
            : selectedCount > 1
              ? "Upload photos"
              : "Upload photo"}
        </button>
        <UploadProgressList
          items={upload.state.items}
          statusMessage={upload.state.statusMessage}
          catalogRefreshError={upload.state.catalogRefreshError}
          returnTo={returnTo}
          onViewTrash={onViewTrash}
          onRetry={(itemId) => void upload.actions.retryItem(itemId)}
        />
      </form>
      {upload.state.currentReview ? (
        <PossibleDuplicateReview
          key={upload.state.currentReview.id}
          file={upload.state.currentReview.file}
          candidates={upload.state.currentReview.candidates}
          isSubmitting={upload.state.isConfirmingReview}
          error={upload.state.currentReview.error}
          onKeep={() => void upload.actions.keepCurrentReview()}
          onCancel={upload.actions.cancelCurrentReview}
        />
      ) : null}
    </>
  );
}
