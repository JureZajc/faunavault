"use client";

import ClassificationJobsPanel from "../classification-jobs-panel";
import { Photo } from "../../lib/api";
import { PhotoClassificationController } from "../../hooks/use-photo-classification";

type PhotoClassificationPanelProps = {
  photo: Photo;
  controller: PhotoClassificationController;
  disabled: boolean;
};

export default function PhotoClassificationPanel({
  photo,
  controller,
  disabled,
}: PhotoClassificationPanelProps) {
  return (
    <>
      <button
        type="button"
        onClick={() => void controller.runAiClassification()}
        disabled={disabled || controller.hasActiveJobs}
        className="min-h-11 w-full rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
      >
        {controller.hasActiveJobs
          ? "Local AI classification queued"
          : photo.status === "pending"
            ? "Run local AI classification"
            : "Reclassify with local AI"}
      </button>
      {controller.error ? (
        <p role="alert" className="text-sm text-red-700">
          {controller.error}
        </p>
      ) : null}
      <ClassificationJobsPanel
        jobs={controller.jobs}
        photos={[photo]}
        onRetry={controller.retry}
      />
      <button
        type="button"
        onClick={() => void controller.runMockClassification()}
        disabled={disabled}
        className="min-h-11 w-full rounded-md border border-emerald-800 bg-white px-4 text-sm font-semibold text-emerald-900 transition hover:border-emerald-900 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
      >
        {controller.isMockClassifying
          ? "Running mock classification"
          : "Run mock classification"}
      </button>
    </>
  );
}
