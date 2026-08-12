"use client";

import { useState } from "react";
import {
  classifyPhoto,
  mockClassifyPhoto,
  Photo,
} from "../lib/api";
import { useClassificationJobs } from "./use-classification-jobs";

type Options = {
  photoId: number;
  onRefresh: () => Promise<Photo>;
  onPhotoUpdated: (photo: Photo) => void;
  onError: (message: string | null) => void;
};

export function usePhotoClassification({
  photoId,
  onRefresh,
  onPhotoUpdated,
  onError,
}: Options) {
  const [isMockClassifying, setIsMockClassifying] = useState(false);
  const jobs = useClassificationJobs({
    photoId,
    onSucceeded: async () => {
      await onRefresh();
    },
  });

  async function runAiClassification() {
    onError(null);
    try {
      jobs.acceptEnqueue(await classifyPhoto(photoId));
    } catch (nextError) {
      onError(
        nextError instanceof Error
          ? nextError.message
          : "Local AI classification failed",
      );
    }
  }

  async function runMockClassification() {
    setIsMockClassifying(true);
    onError(null);
    try {
      onPhotoUpdated(await mockClassifyPhoto(photoId));
    } catch (nextError) {
      onError(
        nextError instanceof Error ? nextError.message : "Classification failed",
      );
    } finally {
      setIsMockClassifying(false);
    }
  }

  return {
    jobs: jobs.jobs,
    hasActiveJobs: jobs.hasActiveJobs,
    error: jobs.error,
    retry: jobs.retry,
    isMockClassifying,
    runAiClassification,
    runMockClassification,
  };
}

export type PhotoClassificationController = ReturnType<
  typeof usePhotoClassification
>;
