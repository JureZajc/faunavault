"use client";

import Link from "next/link";
import { ReactNode, useState } from "react";
import { imageUrl, Photo, PhotoStatus } from "../../lib/api";

const statusLabels: Record<PhotoStatus, string> = {
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

function getPhotoCardSubtitle(photo: Photo, title: string) {
  const species = normalizeText(photo.species_guess);
  const common = normalizeText(photo.common_name);
  const formattedCommon = common
    ? `${common.charAt(0).toLocaleUpperCase()}${common.slice(1).toLocaleLowerCase()}`
    : "";
  if (!species) return formattedCommon || "Species not identified";
  if (!common || title.toLocaleLowerCase() === common.toLocaleLowerCase()) {
    return species;
  }
  return `${formattedCommon} · ${species}`;
}

function StatusBadge({ status }: { status: PhotoStatus }) {
  const classes =
    status === "classified"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "needs_review"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-sky-200 bg-sky-50 text-sky-800";
  return (
    <span className={`inline-flex max-w-full shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${classes}`}>
      {statusLabels[status]}
    </span>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="text-xs text-stone-400">No tags yet</span>;
  return (
    <div className="flex min-h-7 flex-wrap gap-1.5">
      {tags.slice(0, 3).map((tag) => (
        <span
          key={tag}
          title={tag}
          className="max-w-[9rem] truncate rounded-full border border-emerald-100 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800"
        >
          {tag}
        </span>
      ))}
      {tags.length > 3 ? (
        <span className="rounded-full border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-stone-500">
          +{tags.length - 3}
        </span>
      ) : null}
    </div>
  );
}

export default function PhotoCard({
  photo,
  returnTo,
  isSelectionMode = false,
  isSelected = false,
  isSelectionBusy = false,
  onToggleSelection,
  action,
}: {
  photo: Photo;
  returnTo: string;
  isSelectionMode?: boolean;
  isSelected?: boolean;
  isSelectionBusy?: boolean;
  onToggleSelection?: (photoId: number) => void;
  action?: ReactNode;
}) {
  const thumbnailUrl = imageUrl("thumbs", photo.thumbnail_filename);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const title = getPhotoDisplayTitle(photo);
  const subtitle = getPhotoCardSubtitle(photo, title);
  const href = `/photos/${photo.id}?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <article
      className={`group relative flex h-full min-w-0 flex-col overflow-hidden rounded-lg bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
        isSelected
          ? "border-2 border-emerald-700 ring-2 ring-emerald-200"
          : "border border-stone-200 hover:border-emerald-300"
      }`}
    >
      {isSelectionMode ? (
        <label className="absolute left-3 top-3 z-10 flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-stone-200 bg-white/95 px-3 text-xs font-semibold text-stone-800 shadow-sm">
          <input
            type="checkbox"
            checked={isSelected}
            disabled={isSelectionBusy}
            aria-label={`Select photo ${photo.id}: ${title}`}
            onClick={(event) => event.stopPropagation()}
            onChange={() => onToggleSelection?.(photo.id)}
            className="h-5 w-5 accent-emerald-800"
          />
          {isSelected ? "Selected" : "Select"}
        </label>
      ) : null}
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
              <h2 className="line-clamp-2 text-base font-semibold leading-6 text-stone-950" title={title}>
                {title}
              </h2>
              <p className="mt-1 line-clamp-2 text-sm italic leading-5 text-stone-500" title={subtitle}>
                {subtitle}
              </p>
            </div>
            <StatusBadge status={photo.status} />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="inline-flex max-w-full items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium capitalize text-stone-700">
              <span title={photo.category ?? "Unknown"} className="truncate">
                {photo.category ?? "Unknown"}
              </span>
            </span>
            <span className="inline-flex items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
              {photo.confidence === null
                ? "Unscored"
                : `${Math.round(photo.confidence * 100)}%`}
            </span>
          </div>
          <div className="mt-4"><TagList tags={photo.tags} /></div>
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-stone-100 pt-3 text-xs text-stone-500">
            <span>{formatDate(photo.created_at)}</span>
            <span title={photo.original_filename} className="min-w-0 truncate">
              {photo.original_filename}
            </span>
          </div>
        </Link>
        {!isSelectionMode && action ? (
          <div className="mt-3 border-t border-stone-100 pt-3">{action}</div>
        ) : null}
      </div>
    </article>
  );
}
