"use client";

import { ClassificationJob, Photo } from "../lib/api";

type Props = {
  jobs: ClassificationJob[];
  photos?: Photo[];
  onRetry: (jobId: number) => void | Promise<void>;
};

const labels: Record<ClassificationJob["status"], string> = {
  queued: "Queued",
  running: "Classifying",
  succeeded: "Succeeded",
  failed: "Failed",
};

export default function ClassificationJobsPanel({ jobs, photos = [], onRetry }: Props) {
  if (jobs.length === 0) return null;
  const counts = {
    queued: jobs.filter((job) => job.status === "queued").length,
    running: jobs.filter((job) => job.status === "running").length,
    succeeded: jobs.filter((job) => job.status === "succeeded").length,
    failed: jobs.filter((job) => job.status === "failed").length,
  };

  return (
    <div className="mt-3 space-y-3" aria-label="Classification jobs">
      <p className="text-sm text-stone-600">
        Total {jobs.length} · {counts.queued} queued · {counts.running} running ·{" "}
        {counts.succeeded} succeeded · {counts.failed} failed
      </p>
      <div className="space-y-2">
        {jobs.map((job) => {
          const photo = photos.find((item) => item.id === job.photo_id);
          const resultLabel =
            job.status === "succeeded" && job.classification_status === "needs_review"
              ? "Needs review"
              : labels[job.status];
          return (
            <div key={job.id} className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-stone-900">
                    {job.photo_original_filename ??
                      photo?.original_filename ??
                      `Photo ${job.photo_id}`}
                  </p>
                  <p className="text-xs text-stone-500">
                    {job.failure_message ??
                      (job.actual_model
                        ? `${resultLabel} with ${job.actual_model}`
                        : resultLabel)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-stone-700">{resultLabel}</span>
                  {job.retryable ? (
                    <button
                      type="button"
                      onClick={() => void onRetry(job.id)}
                      className="min-h-9 rounded-md border border-stone-300 bg-white px-3 text-xs font-semibold"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
