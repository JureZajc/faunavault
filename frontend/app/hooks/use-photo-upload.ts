"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  Photo,
  VisualDuplicateCandidate,
  uploadPhoto,
} from "../lib/api";

export type UploadItemStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "possible_duplicate"
  | "exact_duplicate"
  | "failed"
  | "cancelled";

export type UploadFailureKind =
  | "validation"
  | "too_large"
  | "unsupported_format"
  | "server"
  | "network"
  | "unexpected";

export type UploadItem = {
  id: string;
  selectionIndex: number;
  filename: string;
  file: File | null;
  status: UploadItemStatus;
  photo?: Photo;
  exactDuplicate?: {
    message: string;
    photoId?: number;
    location?: "catalog" | "trash";
  };
  possibleDuplicate?: {
    message: string;
    candidates: VisualDuplicateCandidate[];
  };
  failure?: {
    kind: UploadFailureKind;
    message: string;
    retryable: boolean;
  };
  reviewError?: string;
};

export type UploadQueueSummary = {
  total: number;
  queued: number;
  uploading: number;
  uploaded: number;
  possibleDuplicate: number;
  exactDuplicate: number;
  failed: number;
  cancelled: number;
};

type Options = {
  refreshCatalog: () => Promise<unknown>;
  onError: (message: string | null) => void;
  onQueueDrained: () => void;
};

function countStatuses(items: UploadItem[]): UploadQueueSummary {
  return items.reduce<UploadQueueSummary>(
    (summary, item) => {
      if (item.status === "possible_duplicate") summary.possibleDuplicate += 1;
      else if (item.status === "exact_duplicate") summary.exactDuplicate += 1;
      else summary[item.status] += 1;
      return summary;
    },
    {
      total: items.length,
      queued: 0,
      uploading: 0,
      uploaded: 0,
      possibleDuplicate: 0,
      exactDuplicate: 0,
      failed: 0,
      cancelled: 0,
    },
  );
}

function finalSummary(summary: UploadQueueSummary) {
  const outcomes = [
    summary.uploaded > 0 ? `${summary.uploaded} uploaded` : null,
    summary.possibleDuplicate > 0
      ? `${summary.possibleDuplicate} possible ${summary.possibleDuplicate === 1 ? "duplicate" : "duplicates"}`
      : null,
    summary.exactDuplicate > 0
      ? `${summary.exactDuplicate} exact ${summary.exactDuplicate === 1 ? "duplicate" : "duplicates"}`
      : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.cancelled > 0 ? `${summary.cancelled} cancelled` : null,
  ].filter((value): value is string => value !== null);
  return `${summary.total} ${summary.total === 1 ? "file" : "files"}: ${outcomes.join(", ")}`;
}

function classifyFailure(error: unknown): UploadItem["failure"] {
  if (error instanceof ApiError) {
    if (error.status === 413) {
      return { kind: "too_large", message: error.message, retryable: false };
    }
    if (error.status === 415) {
      return {
        kind: "unsupported_format",
        message: error.message,
        retryable: false,
      };
    }
    if (error.status >= 500) {
      return { kind: "server", message: error.message, retryable: true };
    }
    return { kind: "validation", message: error.message, retryable: false };
  }
  if (error instanceof TypeError) {
    return {
      kind: "network",
      message: "Could not reach FaunaVault. Check the connection and try again.",
      retryable: true,
    };
  }
  return {
    kind: "unexpected",
    message: error instanceof Error ? error.message : "Upload failed unexpectedly.",
    retryable: false,
  };
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
  const [items, setItems] = useState<UploadItem[]>([]);
  const [isSelectionReady, setIsSelectionReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeReviewId, setActiveReviewId] = useState<string | null>(null);
  const [isConfirmingReview, setIsConfirmingReview] = useState(false);
  const [catalogRefreshError, setCatalogRefreshError] = useState<string | null>(
    null,
  );
  const itemsRef = useRef<UploadItem[]>([]);
  const itemSequence = useRef(0);
  const operationSequence = useRef(0);
  const executionGuard = useRef(false);
  const mounted = useRef(true);
  const catalogDirty = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationSequence.current += 1;
      executionGuard.current = false;
    };
  }, []);

  function replaceItems(nextItems: UploadItem[]) {
    itemsRef.current = nextItems;
    if (mounted.current) setItems(nextItems);
  }

  function updateItems(updater: (current: UploadItem[]) => UploadItem[]) {
    replaceItems(updater(itemsRef.current));
  }

  function updateItem(id: string, updater: (item: UploadItem) => UploadItem) {
    updateItems((current) =>
      current.map((item) => (item.id === id ? updater(item) : item)),
    );
  }

  function operationIsCurrent(operationId: number) {
    return mounted.current && operationSequence.current === operationId;
  }

  function nextPossibleDuplicate() {
    return itemsRef.current.find(
      (item) => item.status === "possible_duplicate",
    );
  }

  async function flushCatalog(operationId: number) {
    if (!catalogDirty.current || !operationIsCurrent(operationId)) return;
    try {
      await refreshCatalog();
      if (!operationIsCurrent(operationId)) return;
      catalogDirty.current = false;
      setCatalogRefreshError(null);
    } catch (error) {
      if (!operationIsCurrent(operationId)) return;
      setCatalogRefreshError(
        `Uploads were saved, but the catalog could not be refreshed: ${
          error instanceof Error ? error.message : "Catalog unavailable"
        }.`,
      );
    }
  }

  async function uploadItem(
    itemId: string,
    file: File,
    operationId: number,
  ) {
    updateItem(itemId, (item) => ({
      ...item,
      status: "uploading",
      photo: undefined,
      exactDuplicate: undefined,
      failure: undefined,
      reviewError: undefined,
    }));
    try {
      const photo = await uploadPhoto(file);
      if (!operationIsCurrent(operationId)) return;
      catalogDirty.current = true;
      updateItem(itemId, (item) => ({
        ...item,
        file: null,
        status: "uploaded",
        photo,
        possibleDuplicate: undefined,
      }));
    } catch (error) {
      if (!operationIsCurrent(operationId)) return;
      if (
        error instanceof ApiError &&
        error.details.code === "duplicate_photo"
      ) {
        updateItem(itemId, (item) => ({
          ...item,
          file: null,
          status: "exact_duplicate",
          exactDuplicate: {
            message: error.message,
            photoId: error.details.photo_id,
            location: error.details.location,
          },
          possibleDuplicate: undefined,
        }));
        return;
      }
      if (
        error instanceof ApiError &&
        error.details.code === "possible_visual_duplicate" &&
        error.details.candidates?.length
      ) {
        updateItem(itemId, (item) => ({
          ...item,
          file,
          status: "possible_duplicate",
          possibleDuplicate: {
            message: error.message,
            candidates: error.details.candidates ?? [],
          },
        }));
        return;
      }
      const failure = classifyFailure(error);
      updateItem(itemId, (item) => ({
        ...item,
        file: failure?.retryable ? file : null,
        status: "failed",
        failure,
        possibleDuplicate: undefined,
      }));
    }
  }

  function selectFiles(files: File[]) {
    if (executionGuard.current || activeReviewId !== null) return;
    const nextItems = files.map<UploadItem>((file, selectionIndex) => {
      itemSequence.current += 1;
      return {
        id: `upload-${itemSequence.current}`,
        selectionIndex,
        filename: file.name,
        file,
        status: "queued",
      };
    });
    replaceItems(nextItems);
    setIsSelectionReady(nextItems.length > 0);
  }

  async function submit(form: HTMLFormElement) {
    if (executionGuard.current || !isSelectionReady) return;
    const queuedItems = itemsRef.current.filter(
      (item) => item.status === "queued" && item.file,
    );
    if (queuedItems.length === 0) return;

    executionGuard.current = true;
    const operationId = operationSequence.current + 1;
    operationSequence.current = operationId;
    setIsSelectionReady(false);
    setIsProcessing(true);
    setCatalogRefreshError(null);
    onError(null);
    form.reset();

    try {
      for (const item of queuedItems) {
        if (!operationIsCurrent(operationId) || !item.file) break;
        await uploadItem(item.id, item.file, operationId);
      }
      await flushCatalog(operationId);
      if (!operationIsCurrent(operationId)) return;
      const review = nextPossibleDuplicate();
      setActiveReviewId(review?.id ?? null);
    } finally {
      if (operationIsCurrent(operationId)) {
        executionGuard.current = false;
        setIsProcessing(false);
      }
    }
  }

  async function finishReview(operationId: number) {
    const nextReview = nextPossibleDuplicate();
    if (nextReview) {
      setActiveReviewId(nextReview.id);
      return;
    }
    await flushCatalog(operationId);
    if (!operationIsCurrent(operationId)) return;
    setActiveReviewId(null);
    onQueueDrained();
  }

  async function keepCurrentReview() {
    if (executionGuard.current) return;
    const review = itemsRef.current.find((item) => item.id === activeReviewId);
    if (
      !review ||
      review.status !== "possible_duplicate" ||
      !review.file ||
      !review.possibleDuplicate
    ) {
      return;
    }

    executionGuard.current = true;
    const operationId = operationSequence.current + 1;
    operationSequence.current = operationId;
    setIsConfirmingReview(true);
    updateItem(review.id, (item) => ({
      ...item,
      status: "uploading",
      reviewError: undefined,
    }));

    let reviewResolved = false;
    try {
      const photo = await uploadPhoto(review.file, true);
      if (!operationIsCurrent(operationId)) return;
      catalogDirty.current = true;
      updateItem(review.id, (item) => ({
        ...item,
        file: null,
        status: "uploaded",
        photo,
        possibleDuplicate: undefined,
      }));
      reviewResolved = true;
    } catch (error) {
      if (!operationIsCurrent(operationId)) return;
      if (
        error instanceof ApiError &&
        error.details.code === "duplicate_photo"
      ) {
        updateItem(review.id, (item) => ({
          ...item,
          file: null,
          status: "exact_duplicate",
          exactDuplicate: {
            message: error.message,
            photoId: error.details.photo_id,
            location: error.details.location,
          },
          possibleDuplicate: undefined,
        }));
        reviewResolved = true;
      } else if (
        error instanceof ApiError &&
        error.details.code === "possible_visual_duplicate" &&
        error.details.candidates?.length
      ) {
        updateItem(review.id, (item) => ({
          ...item,
          status: "possible_duplicate",
          possibleDuplicate: {
            message: error.message,
            candidates: error.details.candidates ?? [],
          },
          reviewError: error.message,
        }));
      } else {
        updateItem(review.id, (item) => ({
          ...item,
          status: "possible_duplicate",
          reviewError:
            error instanceof Error ? error.message : "Could not keep both photos",
        }));
      }
    } finally {
      if (operationIsCurrent(operationId)) {
        executionGuard.current = false;
        setIsConfirmingReview(false);
      }
    }

    if (reviewResolved && operationIsCurrent(operationId)) {
      await finishReview(operationId);
    }
  }

  function cancelCurrentReview() {
    if (executionGuard.current || !activeReviewId) return;
    const operationId = operationSequence.current + 1;
    operationSequence.current = operationId;
    updateItem(activeReviewId, (item) => ({
      ...item,
      file: null,
      status: "cancelled",
      possibleDuplicate: undefined,
      reviewError: undefined,
    }));
    void finishReview(operationId);
  }

  async function retryItem(itemId: string) {
    if (executionGuard.current || activeReviewId !== null) return;
    const item = itemsRef.current.find((candidate) => candidate.id === itemId);
    if (
      !item ||
      item.status !== "failed" ||
      !item.failure?.retryable ||
      !item.file
    ) {
      return;
    }

    executionGuard.current = true;
    const operationId = operationSequence.current + 1;
    operationSequence.current = operationId;
    setIsProcessing(true);
    setCatalogRefreshError(null);
    onError(null);
    try {
      await uploadItem(item.id, item.file, operationId);
      await flushCatalog(operationId);
      if (!operationIsCurrent(operationId)) return;
      const review = nextPossibleDuplicate();
      setActiveReviewId(review?.id ?? null);
    } finally {
      if (operationIsCurrent(operationId)) {
        executionGuard.current = false;
        setIsProcessing(false);
      }
    }
  }

  const summary = useMemo(() => countStatuses(items), [items]);
  const currentReviewItem = items.find((item) => item.id === activeReviewId);
  const currentReview =
    currentReviewItem?.file && currentReviewItem.possibleDuplicate
      ? {
          id: currentReviewItem.id,
          file: currentReviewItem.file,
          candidates: currentReviewItem.possibleDuplicate.candidates,
          error: currentReviewItem.reviewError ?? null,
        }
      : null;
  const isQueueActive = isProcessing || activeReviewId !== null;
  const uploadingItem = items.find((item) => item.status === "uploading");
  const statusMessage = uploadingItem
    ? `Uploading ${uploadingItem.selectionIndex + 1} of ${summary.total}`
    : isProcessing
      ? "Finishing uploads"
      : activeReviewId !== null
        ? `${summary.possibleDuplicate} ${summary.possibleDuplicate === 1 ? "file needs" : "files need"} review`
        : isSelectionReady
          ? `${summary.total} ${summary.total === 1 ? "file is" : "files are"} waiting to upload`
          : summary.total > 0
            ? finalSummary(summary)
            : "";
  const selectedFiles = isSelectionReady
    ? items.flatMap((item) => (item.file ? [item.file] : []))
    : [];

  return {
    state: {
      items,
      summary,
      selectedFileLabel: formatSelectedFiles(selectedFiles),
      isSelectionReady,
      isProcessing,
      isQueueActive,
      canSubmit: isSelectionReady && items.length > 0 && !isQueueActive,
      statusMessage,
      catalogRefreshError,
      currentReview,
      isConfirmingReview,
    },
    actions: {
      selectFiles,
      submit,
      retryItem,
      keepCurrentReview,
      cancelCurrentReview,
    },
  };
}
