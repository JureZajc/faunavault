"use client";

import { useState } from "react";
import { Photo, PhotoStatus } from "../../lib/api";
import { PhotoClassificationController } from "../../hooks/use-photo-classification";
import PhotoAnimalSection from "./photo-animal-section";
import PhotoClassificationPanel from "./photo-classification-panel";
import {
  confidenceLabel,
  PhotoMetadataDetails,
  PhotoMetadataEditor,
} from "./photo-metadata";
import { photoDisplayTitle } from "./photo-media";
import PhotoTrashAction from "./photo-trash-action";

const statusLabels: Record<PhotoStatus, string> = {
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};

function StatusBadge({ status }: { status: PhotoStatus }) {
  const className =
    status === "classified"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "needs_review"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-sky-200 bg-sky-50 text-sky-800";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {statusLabels[status]}
    </span>
  );
}

type PhotoSidebarProps = {
  photo: Photo;
  classification: PhotoClassificationController;
  onPhotoUpdated: (photo: Photo) => void;
  onError: (message: string | null) => void;
  onMoved: (photo: Photo) => void | Promise<void>;
};

export default function PhotoSidebar({
  photo,
  classification,
  onPhotoUpdated,
  onError,
  onMoved,
}: PhotoSidebarProps) {
  const [isEditingMetadata, setIsEditingMetadata] = useState(false);
  const [isMetadataBusy, setIsMetadataBusy] = useState(false);
  const [isTrashBusy, setIsTrashBusy] = useState(false);
  const isBusy =
    isMetadataBusy || isTrashBusy || classification.isMockClassifying;

  return (
    <aside className="self-start rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">
            Field record
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-stone-950">
            {photoDisplayTitle(photo)}
          </h1>
          <p className="mt-1 truncate text-sm italic text-stone-500">
            {photo.species_guess ?? "Species not identified"}
          </p>
        </div>
        <StatusBadge status={photo.status} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <span className="inline-flex max-w-full items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium capitalize text-stone-700">
          <span className="truncate">{photo.category ?? "Unknown category"}</span>
        </span>
        <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
          {confidenceLabel(photo.confidence)}
        </span>
      </div>

      <div className="mt-5 grid gap-3">
        <button
          type="button"
          onClick={() => {
            onError(null);
            setIsEditingMetadata(true);
          }}
          disabled={isBusy || isEditingMetadata}
          className="min-h-11 w-full rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-800 transition hover:border-emerald-500 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
        >
          {isEditingMetadata ? "Editing metadata" : "Edit metadata"}
        </button>
        <PhotoClassificationPanel
          photo={photo}
          controller={classification}
          disabled={isBusy || isEditingMetadata}
        />
      </div>

      {isEditingMetadata ? (
        <PhotoMetadataEditor
          photo={photo}
          onSaved={(updatedPhoto) => {
            onPhotoUpdated(updatedPhoto);
            setIsEditingMetadata(false);
          }}
          onCancel={() => {
            onError(null);
            setIsEditingMetadata(false);
          }}
          onBusyChange={setIsMetadataBusy}
          onError={onError}
        />
      ) : (
        <>
          <PhotoMetadataDetails photo={photo} />
          {photo.animal_id ? (
            <PhotoAnimalSection animalId={photo.animal_id} />
          ) : null}
        </>
      )}

      <PhotoTrashAction
        photo={photo}
        disabled={isBusy || isEditingMetadata}
        onMoved={onMoved}
        onBusyChange={setIsTrashBusy}
      />
    </aside>
  );
}
