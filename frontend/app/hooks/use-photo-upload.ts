"use client";

import { useRef, useState } from "react";
import {
  ApiError,
  BatchUploadFailure,
  PossibleVisualDuplicate,
  uploadPhoto,
  uploadPhotoBatch,
} from "../lib/api";

export type UploadNotice = {
  kind: "success" | "warning";
  message: string;
  duplicatePhotoId?: number;
  duplicateLocation?: "catalog" | "trash";
};

type PendingVisualDuplicate = PossibleVisualDuplicate & {
  file: File;
  reviewId: string;
};

type Options = {
  refreshCatalog: () => Promise<unknown>;
  onError: (message: string | null) => void;
  onQueueDrained: () => void;
};

function formatBatchFailureMessage(failed: BatchUploadFailure[]) {
  const visibleFailures = failed
    .slice(0, 3)
    .map((failure) => `${failure.filename}: ${failure.error}`)
    .join("; ");
  const remainingCount = failed.length - Math.min(failed.length, 3);
  return remainingCount > 0
    ? `${visibleFailures}; ${remainingCount} more failed`
    : visibleFailures;
}

export function formatSelectedFiles(files: File[]) {
  if (files.length === 0) return "Choose JPEG, PNG, or WebP images";
  if (files.length === 1) return files[0].name;
  return `${files.length} files selected`;
}

export function usePhotoUpload({
  refreshCatalog,
  onError,
  onQueueDrained,
}: Options) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [notice, setNotice] = useState<UploadNotice | null>(null);
  const [reviewQueue, setReviewQueue] = useState<PendingVisualDuplicate[]>([]);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewSequence = useRef(0);

  function nextReviewId(fileIndex: number) {
    reviewSequence.current += 1;
    return `${fileIndex}-${reviewSequence.current}`;
  }

  function selectFiles(files: File[]) {
    setSelectedFiles(files);
    setNotice(null);
  }

  async function submit(form: HTMLFormElement) {
    if (selectedFiles.length === 0) return;
    setIsUploading(true);
    onError(null);
    setNotice(null);
    try {
      if (selectedFiles.length === 1) {
        await uploadPhoto(selectedFiles[0]);
        await refreshCatalog();
        setNotice({ kind: "success", message: "Uploaded 1 photo." });
      } else {
        const result = await uploadPhotoBatch(selectedFiles);
        const pendingReviews = result.possible_duplicates.flatMap((item) => {
          const file = selectedFiles[item.file_index];
          return file
            ? [{ ...item, file, reviewId: nextReviewId(item.file_index) }]
            : [];
        });
        if (pendingReviews.length > 0) {
          setReviewQueue(pendingReviews);
          setReviewError(null);
        }
        if (result.uploaded.length > 0) await refreshCatalog();

        if (pendingReviews.length > 0) {
          const failureSuffix =
            result.failed.length > 0
              ? ` ${result.failed.length} failed: ${formatBatchFailureMessage(result.failed)}.`
              : "";
          setNotice({
            kind: "warning",
            message: `${result.uploaded.length} uploaded. ${pendingReviews.length} ${pendingReviews.length === 1 ? "photo needs" : "photos need"} review.${failureSuffix}`,
          });
        } else if (result.failed.length > 0 && result.uploaded.length > 0) {
          setNotice({
            kind: "warning",
            message: `Uploaded ${result.uploaded.length} ${result.uploaded.length === 1 ? "photo" : "photos"}. ${result.failed.length} failed: ${formatBatchFailureMessage(result.failed)}.`,
          });
        } else if (result.failed.length > 0) {
          onError(
            `Upload failed for ${result.failed.length} ${result.failed.length === 1 ? "file" : "files"}: ${formatBatchFailureMessage(result.failed)}.`,
          );
        } else {
          setNotice({
            kind: "success",
            message: `Uploaded ${result.uploaded.length} photos.`,
          });
        }
      }
      setSelectedFiles([]);
      form.reset();
    } catch (nextError) {
      if (
        nextError instanceof ApiError &&
        nextError.details.code === "duplicate_photo"
      ) {
        setNotice({
          kind: "warning",
          message: nextError.message,
          duplicatePhotoId: nextError.details.photo_id,
          duplicateLocation: nextError.details.location,
        });
      } else if (
        nextError instanceof ApiError &&
        nextError.details.code === "possible_visual_duplicate" &&
        nextError.details.candidates?.length
      ) {
        setReviewQueue([
          {
            file_index: 0,
            filename: selectedFiles[0].name,
            message: nextError.message,
            candidates: nextError.details.candidates,
            file: selectedFiles[0],
            reviewId: nextReviewId(0),
          },
        ]);
        setReviewError(null);
        setNotice({
          kind: "warning",
          message: "This photo needs a possible-duplicate review.",
        });
        setSelectedFiles([]);
        form.reset();
      } else {
        onError(nextError instanceof Error ? nextError.message : "Upload failed");
      }
    } finally {
      setIsUploading(false);
    }
  }

  function finishReview() {
    if (reviewQueue.length === 1) onQueueDrained();
    setReviewQueue((current) => current.slice(1));
    setReviewError(null);
  }

  async function keepCurrentReview() {
    const review = reviewQueue[0];
    if (!review) return;
    setIsConfirmingReview(true);
    setReviewError(null);
    try {
      await uploadPhoto(review.file, true);
      try {
        await refreshCatalog();
        setNotice({
          kind: "success",
          message: `Uploaded ${review.filename} and kept both photos.`,
        });
      } catch (refreshError) {
        setNotice({
          kind: "warning",
          message: `Uploaded ${review.filename}, but the catalog could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "Catalog unavailable"}.`,
        });
      }
      finishReview();
    } catch (nextError) {
      setReviewError(
        nextError instanceof Error
          ? nextError.message
          : "Could not keep both photos",
      );
    } finally {
      setIsConfirmingReview(false);
    }
  }

  function cancelCurrentReview() {
    const review = reviewQueue[0];
    finishReview();
    if (review) {
      setNotice({
        kind: "warning",
        message: `Cancelled upload of ${review.filename}.`,
      });
    }
  }

  return {
    selectedFiles,
    selectedFileLabel: formatSelectedFiles(selectedFiles),
    isUploading,
    notice,
    currentReview: reviewQueue[0] ?? null,
    hasPendingReviews: reviewQueue.length > 0,
    isConfirmingReview,
    reviewError,
    selectFiles,
    submit,
    keepCurrentReview,
    cancelCurrentReview,
  };
}
