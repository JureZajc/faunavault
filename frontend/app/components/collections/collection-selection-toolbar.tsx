"use client";

import { useEffect, useRef } from "react";

export default function CollectionSelectionToolbar({ selectedIds, visibleIds, error, onTogglePage, onClear, onExit, onRemove }: {
  selectedIds: ReadonlySet<number>;
  visibleIds: number[];
  error: string | null;
  onTogglePage: (ids: number[]) => void;
  onClear: () => void;
  onExit: () => void;
  onRemove: () => void;
}) {
  const pageRef = useRef<HTMLInputElement>(null);
  const selectedVisible = visibleIds.filter((id) => selectedIds.has(id)).length;
  const all = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  useEffect(() => { if (pageRef.current) pageRef.current.indeterminate = selectedVisible > 0 && !all; }, [all, selectedVisible]);
  return <section aria-label="Collection photo actions" className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 sm:p-4">
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"><p className="font-semibold" aria-live="polite">{selectedIds.size} selected</p><label className="flex min-h-11 items-center gap-2 rounded-md border bg-white px-3 text-sm font-semibold"><input ref={pageRef} type="checkbox" checked={all} onChange={() => onTogglePage(visibleIds)} className="h-5 w-5 accent-emerald-800" />Select page</label><button type="button" disabled={!selectedIds.size} onClick={onClear} className="min-h-11 rounded-md border bg-white px-3 text-sm font-semibold disabled:opacity-50">Clear selection</button><button type="button" onClick={onExit} className="min-h-11 rounded-md border bg-white px-3 text-sm font-semibold">Exit selection</button></div>
      <button type="button" disabled={!selectedIds.size} onClick={onRemove} className="min-h-11 rounded-md bg-amber-700 px-4 text-sm font-semibold text-white disabled:opacity-50">Remove from Collection</button>
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
  </section>;
}
