"use client";

import { ReactNode, useMemo } from "react";
import { CatalogPhotoPage, Photo } from "../../lib/api";
import { CatalogLayout } from "../../lib/catalog-query";
import MoveToTrashButton from "../move-to-trash-button";
import PhotoCard from "./photo-card";

const localeCompareOptions: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function groupPhotosByCategory(photos: Photo[]) {
  const groups = photos.reduce<Map<string, Photo[]>>((current, photo) => {
    const label = photo.category?.trim() || "Unknown";
    current.set(label, [...(current.get(label) ?? []), photo]);
    return current;
  }, new Map());
  return Array.from(groups.entries())
    .sort(([first], [second]) => first.localeCompare(second, "en", localeCompareOptions))
    .map(([category, items]) => ({ category, items }));
}

function CatalogStateMessage({ title, description, action }: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white px-4 py-12 text-center sm:px-6 sm:py-16">
      <h2 className="text-xl font-semibold text-stone-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-500">{description}</p>
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
  isSelectionMode: boolean;
  selectedIds: ReadonlySet<number>;
  isSelectionBusy: boolean;
  onToggleSelection: (photoId: number) => void;
};

export default function CatalogResults(props: CatalogResultsProps) {
  const photos = useMemo(() => props.catalog?.items ?? [], [props.catalog?.items]);
  const groups = useMemo(() => groupPhotosByCategory(photos), [photos]);
  const card = (photo: Photo) => (
    <PhotoCard
      key={photo.id}
      photo={photo}
      returnTo={props.returnTo}
      isSelectionMode={props.isSelectionMode}
      isSelected={props.selectedIds.has(photo.id)}
      isSelectionBusy={props.isSelectionBusy}
      onToggleSelection={props.onToggleSelection}
      action={<MoveToTrashButton
        photo={photo}
        onMoved={props.onPhotoMoved}
        onError={props.onError}
        className="min-h-10 w-full rounded-md border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 hover:border-red-200 hover:text-red-700"
      />}
    />
  );

  return <>
    {props.error ? <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 break-words">{props.error}</p>
        <button type="button" onClick={props.onRetry} disabled={props.isLoading} className="min-h-9 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60">Retry</button>
      </div>
    </div> : null}

    {props.error ? null : props.isLoading ? (
      <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => <div key={index} className="h-[28rem] animate-pulse rounded-lg border border-stone-200 bg-white" />)}
      </div>
    ) : (props.catalog?.facets.active_total ?? 0) === 0 ? (
      <div className="py-8"><CatalogStateMessage title="Start your animal archive" description="Upload an image to create the first record in this local collection." /></div>
    ) : photos.length > 0 && props.viewMode === "flat" ? (
      <div className="grid items-stretch gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{photos.map(card)}</div>
    ) : photos.length > 0 ? (
      <div className="space-y-8 py-8">{groups.map((group) => <section key={group.category}>
        <div className="mb-3 flex items-start justify-between gap-3 border-b border-stone-200 pb-2">
          <h2 className="min-w-0 break-words text-lg font-semibold text-stone-950">{group.category}</h2>
          <span className="shrink-0 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500">{group.items.length} {group.items.length === 1 ? "record" : "records"}</span>
        </div>
        <div className="grid items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{group.items.map(card)}</div>
      </section>)}</div>
    ) : (
      <div className="py-8"><CatalogStateMessage title="No matching records" description="Try a broader search, switch category or status, or clear the current catalog filters." action={props.hasActiveFilters ? <button type="button" onClick={props.onClearFilters} className="min-h-10 rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-50">Clear filters</button> : null} /></div>
    )}

    {!props.error && props.catalog && props.catalog.total_pages > 1 ? <nav aria-label="Catalog pagination" className="flex flex-wrap items-center justify-center gap-3 pb-10">
      <button type="button" disabled={props.catalog.page === 1 || props.isLoading} onClick={() => props.onPageChange(props.catalog!.page - 1)} className="min-h-11 rounded-md border border-stone-200 bg-white px-4 text-sm font-semibold disabled:opacity-40">Previous</button>
      <span className="text-sm text-stone-600" aria-live="polite">Page {props.catalog.page} of {props.catalog.total_pages}</span>
      <button type="button" disabled={props.catalog.page >= props.catalog.total_pages || props.isLoading} onClick={() => props.onPageChange(props.catalog!.page + 1)} className="min-h-11 rounded-md border border-stone-200 bg-white px-4 text-sm font-semibold disabled:opacity-40">Next</button>
    </nav> : null}
  </>;
}
