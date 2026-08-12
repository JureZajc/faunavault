"use client";

import ClassificationJobsPanel from "../classification-jobs-panel";
import { ClassificationJob } from "../../lib/api";

type CatalogClassificationPanelProps = {
  pendingPhotoCount: number;
  jobs: ClassificationJob[];
  isClassifying: boolean;
  isCatalogLoading: boolean;
  error: string | null;
  onClassify: () => void;
  onRetry: (jobId: number) => void | Promise<void>;
};

export default function CatalogClassificationPanel({
  pendingPhotoCount,
  jobs,
  isClassifying,
  isCatalogLoading,
  error,
  onClassify,
  onRetry,
}: CatalogClassificationPanelProps) {
  return (
    <div className="mt-4 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-stone-900">
            {pendingPhotoCount} pending{" "}
            {pendingPhotoCount === 1 ? "photo" : "photos"}
          </p>
          <p className="mt-1 text-sm text-stone-500">
            Run local AI classification for pending catalog records.
          </p>
        </div>
        <button
          type="button"
          onClick={onClassify}
          disabled={
            pendingPhotoCount === 0 || isClassifying || isCatalogLoading
          }
          className="min-h-11 rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {isClassifying
            ? "Classifying pending photos"
            : "Classify pending photos"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      <ClassificationJobsPanel jobs={jobs} onRetry={onRetry} />
    </div>
  );
}
