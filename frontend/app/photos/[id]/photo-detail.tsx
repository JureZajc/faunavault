"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  classifyPhoto,
  deletePhoto,
  getPhoto,
  imageUrl,
  mockClassifyPhoto,
  Photo,
  PhotoStatus,
} from "../../lib/api";

const statusLabels: Record<PhotoStatus, string> = {
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function confidenceLabel(value: number | null) {
  return value === null ? "Not available" : `${Math.round(value * 100)}%`;
}

function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null;
}) {
  return (
    <div className="border-b border-stone-200 py-3 last:border-0">
      <dt className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-stone-950">{value ?? "Not available"}</dd>
    </div>
  );
}

export default function PhotoDetail({ id }: { id: string }) {
  const router = useRouter();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMockClassifying, setIsMockClassifying] = useState(false);
  const [isAiClassifying, setIsAiClassifying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isClassifying = isMockClassifying || isAiClassifying || isDeleting;
  const detailImageUrl = photo
    ? photo.resized_filename
      ? imageUrl("resized", photo.resized_filename)
      : imageUrl("original", photo.stored_filename)
    : null;
  const imageFailed =
    detailImageUrl !== null && failedImageUrl === detailImageUrl;

  useEffect(() => {
    getPhoto(id)
      .then(setPhoto)
      .catch((nextError: Error) => setError(nextError.message))
      .finally(() => setIsLoading(false));
  }, [id]);

  async function handleMockClassify() {
    if (!photo) {
      return;
    }

    setIsMockClassifying(true);
    setError(null);
    try {
      const updatedPhoto = await mockClassifyPhoto(photo.id);
      setPhoto(updatedPhoto);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Classification failed",
      );
    } finally {
      setIsMockClassifying(false);
    }
  }

  async function handleAiClassify() {
    if (!photo) {
      return;
    }

    setIsAiClassifying(true);
    setError(null);
    try {
      const updatedPhoto = await classifyPhoto(photo.id);
      setPhoto(updatedPhoto);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Local AI classification failed",
      );
    } finally {
      setIsAiClassifying(false);
    }
  }

  async function handleDelete() {
    if (!photo) {
      return;
    }

    const confirmed = window.confirm(
      `Delete photo "${photo.original_filename}"? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setIsDeleting(true);
    setError(null);
    try {
      await deletePhoto(photo.id);
      router.push("/");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Delete failed");
      setIsDeleting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-6 py-6">
        <Link
          href="/"
          className="inline-flex rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-emerald-300"
        >
          Back to catalog
        </Link>

        {error ? (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {isLoading ? (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="aspect-[4/3] animate-pulse rounded-lg bg-stone-200" />
            <div className="h-96 animate-pulse rounded-lg bg-white" />
          </div>
        ) : photo ? (
          <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <section className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
              <div className="bg-stone-100">
                {imageFailed || !detailImageUrl ? (
                  <div className="flex aspect-[4/3] max-h-[72vh] w-full items-center justify-center px-6 text-center text-sm font-medium text-stone-500">
                    Image unavailable
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element -- Backend localhost images must bypass Next image optimization.
                  <img
                    src={detailImageUrl}
                    alt={photo.common_name ?? photo.original_filename}
                    className="max-h-[72vh] w-full object-contain"
                    onError={() => setFailedImageUrl(detailImageUrl)}
                  />
                )}
              </div>
            </section>

            <aside className="self-start rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">
                    Field record
                  </p>
                  <h1 className="mt-2 text-2xl font-semibold text-stone-950">
                    {photo.common_name ?? "Unclassified"}
                  </h1>
                </div>
                <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium text-stone-700">
                  {statusLabels[photo.status]}
                </span>
              </div>

              <button
                type="button"
                onClick={handleMockClassify}
                disabled={isClassifying}
                className="mt-5 min-h-11 w-full rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                {isMockClassifying ? "Running mock classification" : "Run mock classification"}
              </button>

              <button
                type="button"
                onClick={handleAiClassify}
                disabled={isClassifying}
                className="mt-3 min-h-11 w-full rounded-md border border-emerald-800 bg-white px-4 text-sm font-semibold text-emerald-900 transition hover:border-emerald-900 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
              >
                {isAiClassifying
                  ? "Running local AI classification"
                  : "Run local AI classification"}
              </button>

              <button
                type="button"
                onClick={handleDelete}
                disabled={isClassifying}
                className="mt-3 min-h-11 w-full rounded-md border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
              >
                {isDeleting ? "Deleting photo" : "Delete photo"}
              </button>

              <dl className="mt-5">
                <MetadataRow label="Original file" value={photo.original_filename} />
                <MetadataRow label="Species guess" value={photo.species_guess} />
                <MetadataRow label="Category" value={photo.category} />
                <MetadataRow
                  label="Confidence"
                  value={confidenceLabel(photo.confidence)}
                />
                <MetadataRow label="Status" value={statusLabels[photo.status]} />
                <MetadataRow label="Created" value={formatDateTime(photo.created_at)} />
                <MetadataRow label="Updated" value={formatDateTime(photo.updated_at)} />
              </dl>

              <div className="mt-5 border-t border-stone-200 pt-5">
                <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
                  Description
                </h2>
                <p className="mt-2 text-sm leading-6 text-stone-700">
                  {photo.description ?? "Not available"}
                </p>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {photo.tags.length > 0 ? (
                  photo.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-emerald-100 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800"
                    >
                      {tag}
                    </span>
                  ))
                ) : (
                  <span className="text-sm text-stone-500">No tags</span>
                )}
              </div>
            </aside>
          </div>
        ) : (
          <div className="py-20 text-center">
            <h1 className="text-xl font-semibold">Photo not found</h1>
          </div>
        )}
      </div>
    </main>
  );
}
