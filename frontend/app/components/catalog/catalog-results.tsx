"use client";

import Link from "next/link";
import { ReactNode, useMemo, useState } from "react";
import MoveToTrashButton from "../move-to-trash-button";
import {
  CatalogPhotoPage,
  imageUrl,
  Photo,
  PhotoStatus,
} from "../../lib/api";
import { CatalogLayout } from "../../lib/catalog-query";

const statusLabels: Record<PhotoStatus, string> = {
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};
const localeCompareOptions: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatConfidence(value: number | null) {
  return value === null ? "Unscored" : `${Math.round(value * 100)}%`;
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function getPhotoDisplayTitle(photo: Photo) {
  return (
    normalizeText(photo.display_title) ||
    normalizeText(photo.breed_guess) ||
    normalizeText(photo.common_name) ||
    "Unclassified"
  );
}

function formatCommonNameForSubtitle(value: string) {
  const normalizedValue = normalizeText(value).toLocaleLowerCase();
  if (!normalizedValue) return "";
  return `${normalizedValue.charAt(0).toLocaleUpperCase()}${normalizedValue.slice(1)}`;
}

function getPhotoCardSubtitle(photo: Photo, title: string) {
  const speciesGuess = normalizeText(photo.species_guess);
  const commonName = normalizeText(photo.common_name);
  if (!speciesGuess) {
    return commonName
      ? formatCommonNameForSubtitle(commonName)
      : "Species not identified";
  }
  if (
    !commonName ||
    title.trim().toLocaleLowerCase() === commonName.toLocaleLowerCase()
  ) {
    return speciesGuess;
  }
  return `${formatCommonNameForSubtitle(commonName)} · ${speciesGuess}`;
}

function groupPhotosByCategory(photos: Photo[]) {
  const groups = photos.reduce<Map<string, Photo[]>>((current, photo) => {
    const label = photo.category?.trim() || "Unknown";
    const items = current.get(label) ?? [];
    items.push(photo);
    current.set(label, items);
    return current;
  }, new Map());
  return Array.from(groups.entries())
    .sort(([first], [second]) =>
      first.localeCompare(second, "en", localeCompareOptions),
    )
    .map(([category, photos]) => ({ category, photos }));
}

function StatusBadge({ status }: { status: PhotoStatus }) {
  const className =
    status === "classified"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "needs_review"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-sky-200 bg-sky-50 text-sky-800";
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {statusLabels[status]}
    </span>
  );
}

function TagList({ tags, limit = 3 }: { tags: string[]; limit?: number }) {
  const visibleTags = tags.slice(0, limit);
  const remainingCount = tags.length - visibleTags.length;
  if (tags.length === 0) {
    return <span className="text-xs text-stone-400">No tags yet</span>;
  }
  return (
    <div className="flex min-h-7 flex-wrap gap-1.5">
      {visibleTags.map((tag) => (
        <span
          key={tag}
          title={tag}
          className="max-w-[9rem] truncate rounded-full border border-emerald-100 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800"
        >
          {tag}
        </span>
      ))}
      {remainingCount > 0 ? (
        <span className="rounded-full border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-stone-500">
          +{remainingCount}
        </span>
      ) : null}
    </div>
  );
}

function PhotoCard({
  photo,
  returnTo,
  onMoved,
  onError,
}: {
  photo: Photo;
  returnTo: string;
  onMoved: (photo: Photo) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const thumbnailUrl = imageUrl("thumbs", photo.thumbnail_filename);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const title = getPhotoDisplayTitle(photo);
  const subtitle = getPhotoCardSubtitle(photo, title);
  const href = `/photos/${photo.id}?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <article className="group flex min-w-0 h-full flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
      <Link href={href} className="block">
        <div className="aspect-[4/3] overflow-hidden bg-stone-100">
          {failedImageUrl === thumbnailUrl ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm font-medium text-stone-500">
              Image unavailable
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- Backend localhost images must bypass Next image optimization.
            <img
              src={thumbnailUrl}
              alt={title}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
              onError={() => setFailedImageUrl(thumbnailUrl)}
            />
          )}
        </div>
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <Link href={href} className="block flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                title={title}
                className="line-clamp-2 text-base font-semibold leading-6 text-stone-950"
              >
                {title}
              </h2>
              <p
                title={subtitle}
                className="mt-1 line-clamp-2 text-sm italic leading-5 text-stone-500"
              >
                {subtitle}
              </p>
            </div>
            <StatusBadge status={photo.status} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="inline-flex max-w-full items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium capitalize text-stone-700">
              <span
                title={photo.category ?? "Unknown"}
                className="truncate"
              >
                {photo.category ?? "Unknown"}
              </span>
            </span>
            <span className="inline-flex items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
              {formatConfidence(photo.confidence)}
            </span>
          </div>
          <div className="mt-4">
            <TagList tags={photo.tags} />
          </div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-stone-100 pt-3 text-xs text-stone-500">
            <span>{formatDate(photo.created_at)}</span>
            <span
              title={photo.original_filename}
              className="min-w-0 truncate"
            >
              {photo.original_filename}
            </span>
          </div>
        </Link>
        <div className="mt-3 border-t border-stone-100 pt-3">
          <MoveToTrashButton
            photo={photo}
            onMoved={onMoved}
            onError={onError}
            className="min-h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 hover:border-red-200 hover:text-red-700"
          />
        </div>
      </div>
    </article>
  );
}

function CatalogStateMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-12 text-center sm:px-6 sm:py-16">
      <h2 className="text-xl font-semibold text-stone-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-500">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

type CatalogResultsProps = {
  catalog: CatalogPhotoPage | null;
  isLoading: boolean;
  error: string | null;
  viewMode: CatalogLayout;
  hasActiveFilters: boolean;
  returnTo: string;
  onRetry: () => void;
  onClearFilters: () => void;
  onPageChange: (page: number) => void;
  onPhotoMoved: (photo: Photo) => void | Promise<void>;
  onError: (message: string) => void;
};

export default function CatalogResults({
  catalog,
  isLoading,
  error,
  viewMode,
  hasActiveFilters,
  returnTo,
  onRetry,
  onClearFilters,
  onPageChange,
  onPhotoMoved,
  onError,
}: CatalogResultsProps) {
  const photos = useMemo(() => catalog?.items ?? [], [catalog?.items]);
  const groups = useMemo(() => groupPhotosByCategory(photos), [photos]);

  return (
    <>
      {error ? (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 break-words">{error}</p>
            <button
              type="button"
              onClick={onRetry}
              disabled={isLoading}
              className="min-h-9 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {error ? null : isLoading ? (
        <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="h-[28rem] animate-pulse rounded-lg border border-stone-200 bg-white"
            />
          ))}
        </div>
      ) : (catalog?.facets.active_total ?? 0) === 0 ? (
        <div className="py-8">
          <CatalogStateMessage
            title="Start your animal archive"
            description="Upload an image to create the first record in this local collection."
          />
        </div>
      ) : photos.length > 0 && viewMode === "flat" ? (
        <div className="grid items-stretch gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {photos.map((photo) => (
            <PhotoCard
              key={photo.id}
              photo={photo}
              returnTo={returnTo}
              onMoved={onPhotoMoved}
              onError={onError}
            />
          ))}
        </div>
      ) : photos.length > 0 ? (
        <div className="space-y-8 py-8">
          {groups.map((group) => (
            <section key={group.category}>
              <div className="mb-3 flex items-start justify-between gap-3 border-b border-stone-200 pb-2">
                <h2 className="min-w-0 break-words text-lg font-semibold text-stone-950">
                  {group.category}
                </h2>
                <span className="shrink-0 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500">
                  {group.photos.length}{" "}
                  {group.photos.length === 1 ? "record" : "records"}
                </span>
              </div>
              <div className="grid items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {group.photos.map((photo) => (
                  <PhotoCard
                    key={photo.id}
                    photo={photo}
                    returnTo={returnTo}
                    onMoved={onPhotoMoved}
                    onError={onError}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="py-8">
          <CatalogStateMessage
            title="No matching records"
            description="Try a broader search, switch category or status, or clear the current catalog filters."
            action={
              hasActiveFilters ? (
                <button
                  type="button"
                  onClick={onClearFilters}
                  className="min-h-10 rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-50"
                >
                  Clear filters
                </button>
              ) : null
            }
          />
        </div>
      )}

      {!error && catalog && catalog.total_pages > 1 ? (
        <nav
          aria-label="Catalog pagination"
          className="flex flex-wrap items-center justify-center gap-3 pb-10"
        >
          <button
            type="button"
            disabled={catalog.page === 1 || isLoading}
            onClick={() => onPageChange(catalog.page - 1)}
            className="min-h-11 rounded-md border border-stone-200 bg-white px-4 text-sm font-semibold disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-stone-600" aria-live="polite">
            Page {catalog.page} of {catalog.total_pages}
          </span>
          <button
            type="button"
            disabled={catalog.page >= catalog.total_pages || isLoading}
            onClick={() => onPageChange(catalog.page + 1)}
            className="min-h-11 rounded-md border border-stone-200 bg-white px-4 text-sm font-semibold disabled:opacity-40"
          >
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}
