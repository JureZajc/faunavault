"use client";

import Link from "next/link";
import { UploadItem } from "../../hooks/use-photo-upload";

type UploadProgressListProps = {
  items: UploadItem[];
  statusMessage: string;
  catalogRefreshError: string | null;
  returnTo: string;
  onViewTrash: () => void;
  onRetry: (itemId: string) => void;
};

const statusPresentation = {
  queued: { icon: "○", label: "Waiting", className: "text-stone-600" },
  uploading: { icon: "↑", label: "Uploading", className: "text-sky-700" },
  uploaded: { icon: "✓", label: "Uploaded", className: "text-emerald-700" },
  possible_duplicate: {
    icon: "!",
    label: "Possible duplicate",
    className: "text-amber-700",
  },
  exact_duplicate: {
    icon: "=",
    label: "Exact duplicate",
    className: "text-amber-700",
  },
  failed: { icon: "×", label: "Failed", className: "text-red-700" },
  cancelled: { icon: "–", label: "Cancelled", className: "text-stone-500" },
} as const;

export default function UploadProgressList({
  items,
  statusMessage,
  catalogRefreshError,
  returnTo,
  onViewTrash,
  onRetry,
}: UploadProgressListProps) {
  if (items.length === 0) return null;

  return (
    <section
      className="mt-4 min-w-0 border-t border-stone-200 pt-4"
      aria-labelledby="upload-progress-title"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="upload-progress-title" className="text-sm font-semibold text-stone-900">
          Upload progress
        </h2>
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="text-xs text-stone-600"
        >
          {statusMessage}
        </p>
      </div>
      <ol className="mt-3 space-y-2">
        {items.map((item) => {
          const presentation = statusPresentation[item.status];
          return (
            <li
              key={item.id}
              className="rounded-md border border-stone-200 bg-white px-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <p
                  title={item.filename}
                  className="min-w-0 truncate text-sm font-medium text-stone-900"
                >
                  {item.filename}
                </p>
                <p
                  className={`max-w-full shrink-0 text-sm font-medium ${presentation.className}`}
                >
                  <span aria-hidden="true" className="mr-1.5">
                    {presentation.icon}
                  </span>
                  {presentation.label}
                </p>
              </div>

              {item.status === "possible_duplicate" && item.possibleDuplicate ? (
                <p className="mt-1 break-words text-xs leading-5 text-amber-800">
                  {item.possibleDuplicate.message}
                </p>
              ) : null}

              {item.status === "exact_duplicate" && item.exactDuplicate ? (
                <div className="mt-1 break-words text-xs leading-5 text-amber-800">
                  <p>{item.exactDuplicate.message}</p>
                  {item.exactDuplicate.location === "catalog" && item.exactDuplicate.photoId ? (
                    <Link
                      href={`/photos/${item.exactDuplicate.photoId}?returnTo=${encodeURIComponent(returnTo)}`}
                      className="font-semibold underline"
                    >
                      View existing photo
                    </Link>
                  ) : item.exactDuplicate.location === "trash" ? (
                    <button
                      type="button"
                      onClick={onViewTrash}
                      className="font-semibold underline"
                    >
                      View Trash
                    </button>
                  ) : null}
                </div>
              ) : null}

              {item.status === "failed" && item.failure ? (
                <div className="mt-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <p
                    role="alert"
                    className="min-w-0 flex-1 break-words text-xs leading-5 text-red-700"
                  >
                    {item.failure.message}
                  </p>
                  {item.failure.retryable ? (
                    <button
                      type="button"
                      onClick={() => onRetry(item.id)}
                      aria-label={`Retry file ${item.selectionIndex + 1}, ${item.filename}`}
                      className="min-h-10 shrink-0 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-semibold text-red-800 transition hover:bg-red-100"
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {catalogRefreshError ? (
        <p
          role="alert"
          className="mt-3 break-words rounded-md bg-amber-50 p-3 text-sm text-amber-800"
        >
          {catalogRefreshError}
        </p>
      ) : null}
    </section>
  );
}
