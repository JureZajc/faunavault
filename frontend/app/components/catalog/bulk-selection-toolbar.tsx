"use client";

import { useEffect, useRef } from "react";

export type BulkDialogAction =
  | "culling"
  | "favorite"
  | "rating"
  | "add_tags"
  | "remove_tags"
  | "category"
  | "move_to_trash";
export type BulkToolbarAction = BulkDialogAction | "add_to_collection";

type BulkSelectionToolbarProps = {
  selectedIds: ReadonlySet<number>;
  visibleIds: number[];
  isBusy: boolean;
  error: string | null;
  onTogglePage: (photoIds: number[]) => void;
  onClear: () => void;
  onExit: () => void;
  onOpenAction: (action: BulkToolbarAction) => void;
  onCompare?: () => void;
};

export default function BulkSelectionToolbar({
  selectedIds,
  visibleIds,
  isBusy,
  error,
  onTogglePage,
  onClear,
  onExit,
  onOpenAction,
  onCompare,
}: BulkSelectionToolbarProps) {
  const selectPageRef = useRef<HTMLInputElement>(null);
  const visibleSelectedCount = visibleIds.filter((photoId) =>
    selectedIds.has(photoId),
  ).length;
  const allVisibleSelected =
    visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  const hasSelection = selectedIds.size > 0;

  useEffect(() => {
    if (selectPageRef.current) {
      selectPageRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  return (
    <section
      aria-label="Bulk photo actions"
      className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 shadow-sm sm:p-4"
    >
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <p className="font-semibold text-emerald-950" aria-live="polite">
            {selectedIds.size} selected
            {selectedIds.size > visibleSelectedCount
              ? ` · ${visibleSelectedCount} on this page`
              : ""}
          </p>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-emerald-200 bg-white px-3 text-sm font-semibold text-emerald-900">
            <input
              ref={selectPageRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={isBusy || visibleIds.length === 0}
              onChange={() => onTogglePage(visibleIds)}
              className="h-5 w-5 accent-emerald-800"
            />
            Select page
          </label>
          <button
            type="button"
            disabled={isBusy || !hasSelection}
            onClick={onClear}
            className="min-h-11 rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Clear selection
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={onExit}
            className="min-h-11 rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold text-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Exit selection
          </button>
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap lg:justify-end">
          {onCompare ? <div>
            <button type="button" disabled={isBusy || selectedIds.size !== 2} onClick={onCompare} aria-describedby="compare-selection-help" className="min-h-11 rounded-md border border-emerald-800 bg-white px-3 text-sm font-semibold text-emerald-900 disabled:opacity-50">Compare</button>
            <p id="compare-selection-help" className="mt-1 text-xs text-stone-600">{selectedIds.size === 2 ? "Compare the selected pair" : "Select exactly two photos to compare"}</p>
          </div> : null}
          {[
            ["add_to_collection", "Add to Collection"],
            ["favorite", "Favorite / Unfavorite"],
            ["rating", "Set rating"],
            ["culling", "Culling decision"],
            ["add_tags", "Add tags"],
            ["remove_tags", "Remove tags"],
            ["category", "Set category"],
            ["move_to_trash", "Move to Trash"],
          ].map(([action, label]) => (
            <button
              key={action}
              type="button"
              disabled={isBusy || !hasSelection}
              onClick={() => onOpenAction(action as BulkToolbarAction)}
              className={`min-h-11 min-w-0 rounded-md px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                action === "move_to_trash"
                  ? "border border-red-200 bg-red-50 text-red-700"
                  : "bg-emerald-800 text-white hover:bg-emerald-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
