"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClassificationEnqueueResponse,
  ClassificationJob,
  getClassificationJobs,
  retryClassificationJob,
} from "../lib/api";

type Options = {
  photoId?: number;
  onSucceeded?: () => void | Promise<void>;
};

export function useClassificationJobs({ photoId, onSucceeded }: Options = {}) {
  const [jobs, setJobs] = useState<ClassificationJob[]>([]);
  const [trackedBatchId, setTrackedBatchId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const previousSucceeded = useRef<Set<number>>(new Set());
  const onSucceededRef = useRef(onSucceeded);

  useEffect(() => {
    onSucceededRef.current = onSucceeded;
  }, [onSucceeded]);

  const load = useCallback(async () => {
    try {
      const response = await getClassificationJobs(
        trackedBatchId
          ? { batchId: trackedBatchId }
          : { photoId, latestPerPhoto: photoId === undefined },
      );
      let visibleJobs = response.jobs;
      if (photoId === undefined && trackedBatchId === null && visibleJobs.length > 0) {
        const activeJobs = visibleJobs.filter(
          (job) => job.status === "queued" || job.status === "running",
        );
        visibleJobs =
          activeJobs.length > 0
            ? activeJobs
            : visibleJobs.filter((job) => job.batch_id === visibleJobs[0].batch_id);
      }
      const nextSucceeded = new Set(
        visibleJobs
          .filter((job) => job.status === "succeeded")
          .map((job) => job.id),
      );
      const hasNewSuccess = [...nextSucceeded].some(
        (jobId) => !previousSucceeded.current.has(jobId),
      );
      previousSucceeded.current = nextSucceeded;
      setJobs(visibleJobs);
      setError(null);
      if (hasNewSuccess) await onSucceededRef.current?.();
      return visibleJobs;
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Could not load classification jobs",
      );
      return [];
    } finally {
      setIsLoading(false);
    }
  }, [photoId, trackedBatchId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const hasActiveJobs = jobs.some(
    (job) => job.status === "queued" || job.status === "running",
  );

  useEffect(() => {
    if (!hasActiveJobs) return;
    let timer: number | null = null;
    const schedule = () => {
      if (document.visibilityState === "visible") {
        timer = window.setTimeout(async () => {
          await load();
          schedule();
        }, 1000);
      }
    };
    const onVisibilityChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "visible") void load().then(schedule);
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [hasActiveJobs, load]);

  const acceptEnqueue = useCallback((response: ClassificationEnqueueResponse) => {
    const nextJobs = response.jobs.map((item) => item.job);
    setJobs(nextJobs);
    if (nextJobs.length > 0) setTrackedBatchId(nextJobs[0].batch_id);
    setError(response.rejected[0]?.message ?? null);
    return response;
  }, []);

  const retry = useCallback(async (jobId: number) => {
    const retried = await retryClassificationJob(jobId);
    setJobs((current) =>
      current.map((job) => (job.id === retried.id ? retried : job)),
    );
  }, []);

  return {
    jobs,
    isLoading,
    error,
    hasActiveJobs,
    acceptEnqueue,
    retry,
    refresh: load,
  };
}
