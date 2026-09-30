"use client";

import Link from "next/link";
import { CatalogTaxonOption } from "../../lib/api";
import { CatalogLayout, CatalogSortOption } from "../../lib/catalog-query";

import {
  CatalogCurationFilters, CatalogCategoryFilter, CatalogDateFilters, CatalogStatusFilter, CatalogTaxonFilter,
  StatusFilter,
} from "./catalog-filter-controls";
export { UNKNOWN_CATEGORY_VALUE } from "./catalog-filter-controls";
export type { StatusFilter } from "./catalog-filter-controls";

const sortLabels: Record<CatalogSortOption, string> = {
  newest: "Added, newest first",
  oldest: "Added, oldest first",
  taken_newest: "Date taken, newest first",
  taken_oldest: "Date taken, oldest first",
  rating_desc: "Rating high to low",
  rating_asc: "Rating low to high",
  confidence_desc: "Confidence high to low",
  confidence_asc: "Confidence low to high",
  name_asc: "Name A-Z",
  name_desc: "Name Z-A",
  species_asc: "Species A-Z",
  species_desc: "Species Z-A",
  needs_review_first: "Needs review first",
  pending_first: "Pending first",
};

type CatalogToolbarProps = {
  favoritesOnly?: boolean;
  ratingFilter?: string;
  onFavoritesOnlyChange: (value: boolean) => void;
  onRatingFilterChange: (value: string) => void;
  searchQuery: string;
  statusFilter: StatusFilter;
  categoryFilter: string;
  takenFrom?: string;
  takenTo?: string;
  sortOption: CatalogSortOption;
  viewMode: CatalogLayout;
  categoryOptions: string[];
  hasUnknownCategory: boolean;
  taxonId?: number;
  taxonOptions: CatalogTaxonOption[];
  taxaLoading: boolean;
  taxaError: string | null;
  hasMoreTaxa: boolean;
  resultCount: number;
  totalCount: number;
  hasActiveFilters: boolean;
  isSelectionMode: boolean;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onCategoryChange: (value: string) => void;
  onTakenFromChange: (value?: string) => void;
  onTakenToChange: (value?: string) => void;
  onSortChange: (value: CatalogSortOption) => void;
  onViewModeChange: (value: CatalogLayout) => void;
  onTaxonFocus: () => void;
  onTaxonChange: (value?: number) => void;
  onLoadMoreTaxa: () => void;
  onResetFilters: () => void;
  onEnterSelectionMode: () => void;
  onSaveSmartCollection?: () => void;
  mapHref?: string;
  mapDisabled?: boolean;
};

export default function CatalogToolbar({
  favoritesOnly, ratingFilter, onFavoritesOnlyChange, onRatingFilterChange,
  searchQuery,
  statusFilter,
  categoryFilter,
  takenFrom,
  takenTo,
  sortOption,
  viewMode,
  categoryOptions,
  hasUnknownCategory,
  taxonId,
  taxonOptions,
  taxaLoading,
  taxaError,
  hasMoreTaxa,
  resultCount,
  totalCount,
  hasActiveFilters,
  isSelectionMode,
  onSearchChange,
  onStatusChange,
  onCategoryChange,
  onTakenFromChange,
  onTakenToChange,
  onSortChange,
  onViewModeChange,
  onTaxonFocus,
  onTaxonChange,
  onLoadMoreTaxa,
  onResetFilters,
  onEnterSelectionMode,
  onSaveSmartCollection,
  mapHref,
  mapDisabled,
}: CatalogToolbarProps) {
  const filterProps = {
    statusFilter, categoryFilter, takenFrom, takenTo, categoryOptions,
    hasUnknownCategory, taxonId, taxonOptions, taxaLoading, taxaError, hasMoreTaxa,
    onStatusChange, onCategoryChange, onTakenFromChange, onTakenToChange,
    onTaxonFocus, onTaxonChange, onLoadMoreTaxa,
  };
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
        <label className="block sm:col-span-2 lg:col-span-1">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Search
          </span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Name, species, camera, description, tags"
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          />
        </label>

        <CatalogTaxonFilter {...filterProps} />

        <CatalogStatusFilter {...filterProps} />

        <CatalogCategoryFilter {...filterProps} />

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Sort
          </span>
          <select
            value={sortOption}
            onChange={(event) =>
              onSortChange(event.target.value as CatalogSortOption)
            }
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          >
            {Object.entries(sortLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <CatalogCurationFilters favoritesOnly={favoritesOnly} ratingFilter={ratingFilter} onFavoritesOnlyChange={onFavoritesOnlyChange} onRatingFilterChange={onRatingFilterChange} />
      <CatalogDateFilters {...filterProps} />

      <div className="mt-4 flex flex-col gap-3 border-t border-stone-100 pt-4 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
        <p>
          Showing <span className="font-semibold text-stone-800">{resultCount}</span>{" "}
          of <span className="font-semibold text-stone-800">{totalCount}</span>{" "}
          {totalCount === 1 ? "record" : "records"}
        </p>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between lg:justify-end">
          <p>Backend-filtered local collection.</p>
          {mapHref ? <div>
            {mapDisabled ? <button type="button" disabled aria-describedby="map-search-explanation" className="min-h-11 rounded-md border border-stone-300 px-4 text-sm font-semibold opacity-50">View on Map</button>
              : <Link href={mapHref} className="inline-flex min-h-11 items-center rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900">View on Map</Link>}
            {mapDisabled ? <p id="map-search-explanation" className="mt-1 text-xs">Clear text search and Favorite/Rating filters to view these filters on Map.</p> : null}
          </div> : null}
          {onSaveSmartCollection ? <button type="button" onClick={onSaveSmartCollection} className="min-h-11 rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900">Save as Smart Collection</button> : null}
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={onResetFilters}
              className="min-h-11 rounded-md border border-stone-300 bg-white px-4 text-sm font-semibold text-stone-700 hover:bg-stone-50"
            >
              Reset filters
            </button>
          ) : null}
          {!isSelectionMode ? (
            <button
              type="button"
              onClick={onEnterSelectionMode}
              className="min-h-11 rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900 hover:bg-emerald-50"
            >
              Select photos
            </button>
          ) : null}
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <span className="shrink-0 text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
              View
            </span>
            <div className="grid w-full min-w-0 grid-cols-2 overflow-hidden rounded-md border border-stone-200 bg-stone-50 p-1 sm:w-auto">
              {[
                ["flat", "Flat grid"],
                ["grouped", "Group by category"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onViewModeChange(value as CatalogLayout)}
                  className={`min-h-11 min-w-0 whitespace-normal rounded px-2 text-xs font-semibold transition sm:min-w-[8.5rem] sm:whitespace-nowrap sm:px-3 ${
                    viewMode === value
                      ? "bg-white text-emerald-900 shadow-sm"
                      : "text-stone-600 hover:text-stone-950"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
