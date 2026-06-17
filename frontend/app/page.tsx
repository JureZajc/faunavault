"use client";

import Link from "next/link";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  deletePhoto,
  getPhotos,
  imageUrl,
  Photo,
  PhotoStatus,
  uploadPhoto,
} from "./lib/api";

const filters: Array<"all" | PhotoStatus> = [
  "all",
  "pending",
  "classified",
  "needs_review",
];

const statusLabels: Record<"all" | PhotoStatus, string> = {
  all: "All",
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function StatusBadge({ status }: { status: PhotoStatus }) {
  const className =
    status === "classified"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "needs_review"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-stone-200 bg-stone-50 text-stone-700";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {statusLabels[status]}
    </span>
  );
}

function PhotoCard({
  photo,
  isDeleting,
  onDelete,
}: {
  photo: Photo;
  isDeleting: boolean;
  onDelete: (photo: Photo) => void;
}) {
  const thumbnailUrl = imageUrl("thumbs", photo.thumbnail_filename);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageFailed = failedImageUrl === thumbnailUrl;

  return (
    <article className="group overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
      <Link href={`/photos/${photo.id}`} className="block">
        <div className="aspect-[4/3] overflow-hidden bg-stone-100">
          {imageFailed ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm font-medium text-stone-500">
              Image unavailable
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- Backend localhost images must bypass Next image optimization.
            <img
              src={thumbnailUrl}
              alt={photo.common_name ?? photo.original_filename}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
              onError={() => setFailedImageUrl(thumbnailUrl)}
            />
          )}
        </div>
      </Link>
      <div className="space-y-3 p-4">
        <Link href={`/photos/${photo.id}`} className="block">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-stone-950">
                {photo.common_name ?? "Unclassified"}
              </h2>
              <p className="mt-1 text-sm capitalize text-stone-500">
                {photo.category ?? "Unknown"}
              </p>
            </div>
            <StatusBadge status={photo.status} />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-stone-500">
            <span>{formatDate(photo.created_at)}</span>
            {photo.confidence !== null ? (
              <span className="font-medium text-emerald-800">
                {Math.round(photo.confidence * 100)}%
              </span>
            ) : null}
          </div>
        </Link>
        <button
          type="button"
          onClick={() => onDelete(photo)}
          disabled={isDeleting}
          className="min-h-10 w-full rounded-md border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
        >
          {isDeleting ? "Deleting photo" : "Delete photo"}
        </button>
      </div>
    </article>
  );
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [activeFilter, setActiveFilter] = useState<"all" | PhotoStatus>("all");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingPhotoIds, setDeletingPhotoIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPhotos()
      .then(setPhotos)
      .catch((nextError: Error) => setError(nextError.message))
      .finally(() => setIsLoading(false));
  }, []);

  const filteredPhotos = useMemo(() => {
    if (activeFilter === "all") {
      return photos;
    }

    return photos.filter((photo) => photo.status === activeFilter);
  }, [activeFilter, photos]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFile(event.target.files?.[0] ?? null);
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile) {
      return;
    }

    setIsUploading(true);
    setError(null);
    try {
      const uploadedPhoto = await uploadPhoto(selectedFile);
      setPhotos((currentPhotos) => [uploadedPhoto, ...currentPhotos]);
      setSelectedFile(null);
      event.currentTarget.reset();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleDeletePhoto(photo: Photo) {
    const confirmed = window.confirm(
      `Delete photo "${photo.original_filename}"? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingPhotoIds((currentIds) => new Set(currentIds).add(photo.id));
    setError(null);
    try {
      await deletePhoto(photo.id);
      setPhotos((currentPhotos) =>
        currentPhotos.filter((currentPhoto) => currentPhoto.id !== photo.id),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Delete failed");
    } finally {
      setDeletingPhotoIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(photo.id);
        return nextIds;
      });
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <section className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-8 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">
              Local-first animal archive
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-950">
              FaunaVault
            </h1>
          </div>
          <form
            onSubmit={handleUpload}
            className="flex w-full flex-col gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 sm:w-auto sm:min-w-[420px] sm:flex-row sm:items-center"
          >
            <label className="flex min-h-11 flex-1 cursor-pointer items-center rounded-md border border-dashed border-stone-300 bg-white px-3 text-sm text-stone-600 transition hover:border-emerald-500">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleFileChange}
                className="sr-only"
              />
              <span className="truncate">
                {selectedFile?.name ?? "Choose image"}
              </span>
            </label>
            <button
              type="submit"
              disabled={!selectedFile || isUploading}
              className="min-h-11 rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {isUploading ? "Uploading" : "Upload"}
            </button>
          </form>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-6">
        <div className="flex flex-col gap-4 border-b border-stone-200 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {filters.map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActiveFilter(filter)}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
                  activeFilter === filter
                    ? "border-emerald-700 bg-emerald-800 text-white"
                    : "border-stone-200 bg-white text-stone-700 hover:border-emerald-300"
                }`}
              >
                {statusLabels[filter]}
              </button>
            ))}
          </div>
          <p className="text-sm text-stone-500">
            {filteredPhotos.length}{" "}
            {filteredPhotos.length === 1 ? "photo" : "photos"}
          </p>
        </div>

        {error ? (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {isLoading ? (
          <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-72 animate-pulse rounded-lg border border-stone-200 bg-white"
              />
            ))}
          </div>
        ) : filteredPhotos.length > 0 ? (
          <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filteredPhotos.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                isDeleting={deletingPhotoIds.has(photo.id)}
                onDelete={handleDeletePhoto}
              />
            ))}
          </div>
        ) : (
          <div className="py-20 text-center">
            <h2 className="text-xl font-semibold text-stone-900">
              No photos in this view
            </h2>
            <p className="mt-2 text-sm text-stone-500">
              Add an image to begin building the collection.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
