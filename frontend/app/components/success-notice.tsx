"use client";

type SuccessNoticeProps = {
  message: string;
  onDismiss: () => void;
  onViewTrash?: () => void;
};

export default function SuccessNotice({
  message,
  onDismiss,
  onViewTrash,
}: SuccessNoticeProps) {
  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 sm:flex-row sm:items-center sm:justify-between"
    >
      <p>{message}</p>
      <div className="flex gap-2">
        {onViewTrash ? (
          <button
            type="button"
            onClick={onViewTrash}
            className="min-h-9 rounded-md border border-emerald-300 bg-white px-3 font-semibold"
          >
            View Trash
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="min-h-9 rounded-md px-3 font-semibold text-emerald-800 hover:bg-emerald-100"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

