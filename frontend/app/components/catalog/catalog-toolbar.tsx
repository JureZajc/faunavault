"use client";

import { CatalogTaxonOption, PhotoStatus } from "../../lib/api";
import { CatalogLayout, CatalogSortOption } from "../../lib/catalog-query";

export type StatusFilter = "all" | PhotoStatus;

export const UNKNOWN_CATEGORY_VALUE = "__unknown__";

const statusFilters: StatusFilter[] = [
  "all",
  "pending",
  "classified",
  "needs_review",
];

const statusLabels: Record<StatusFilter, string> = {
  all: "All statuses",
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};

const sortLabels: Record<CatalogSortOption, string> = {
  newest: "Newest",
  oldest: "Oldest",
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
  searchQuery: string;
  statusFilter: StatusFilter;
  categoryFilter: string;
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
  onSearchChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onCategoryChange: (value: string) => void;
  onSortChange: (value: CatalogSortOption) => void;
  onViewModeChange: (value: CatalogLayout) => void;
  onTaxonFocus: () => void;
  onTaxonChange: (value?: number) => void;
  onLoadMoreTaxa: () => void;
};

export default function CatalogToolbar({
  searchQuery,
  statusFilter,
  categoryFilter,
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
  onSearchChange,
  onStatusChange,
  onCategoryChange,
  onSortChange,
  onViewModeChange,
  onTaxonFocus,
  onTaxonChange,
  onLoadMoreTaxa,
}: CatalogToolbarProps) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Search
          </span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Name, species, category, description, tags"
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          />
        </label>

        <div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
              Verified taxon
            </span>
            <select
              value={taxonId ? String(taxonId) : ""}
              onFocus={onTaxonFocus}
              onChange={(event) =>
                onTaxonChange(
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
              className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
            >
              <option value="">All verified taxa</option>
              {taxonOptions.map((taxon) => (
                <option key={taxon.taxon_id} value={taxon.taxon_id}>
                  {taxon.label} ({taxon.count})
                </option>
              ))}
            </select>
          </label>
          {hasMoreTaxa ? (
            <button
              type="button"
              disabled={taxaLoading}
              onClick={onLoadMoreTaxa}
              className="mt-1 text-xs font-semibold text-emerald-800 underline disabled:opacity-50"
            >
              {taxaLoading ? "Loading taxa…" : "Load more taxa"}
            </button>
          ) : taxaError ? (
            <button
              type="button"
              onClick={onTaxonFocus}
              className="mt-1 text-xs font-semibold text-red-700 underline"
            >
              Retry taxa
            </button>
          ) : null}
        </div>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Status
          </span>
          <select
            value={statusFilter}
            onChange={(event) =>
              onStatusChange(event.target.value as StatusFilter)
            }
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          >
            {statusFilters.map((filter) => (
              <option key={filter} value={filter}>
                {statusLabels[filter]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Category
          </span>
          <select
            value={categoryFilter}
            onChange={(event) => onCategoryChange(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          >
            <option value="all">All categories</option>
            {hasUnknownCategory || categoryFilter === UNKNOWN_CATEGORY_VALUE ? (
              <option value={UNKNOWN_CATEGORY_VALUE}>Unknown</option>
            ) : null}
            {categoryFilter !== "all" &&
            categoryFilter !== UNKNOWN_CATEGORY_VALUE &&
            !categoryOptions.includes(categoryFilter) ? (
              <option value={categoryFilter}>{categoryFilter}</option>
            ) : null}
            {categoryOptions.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

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

      <div className="mt-4 flex flex-col gap-3 border-t border-stone-100 pt-4 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
        <p>
          Showing <span className="font-semibold text-stone-800">{resultCount}</span>{" "}
          of <span className="font-semibold text-stone-800">{totalCount}</span>{" "}
          {totalCount === 1 ? "record" : "records"}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:justify-end">
          <p>Backend-filtered local collection.</p>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
              View
            </span>
            <div className="grid min-h-9 grid-cols-2 overflow-hidden rounded-md border border-stone-200 bg-stone-50 p-1">
              {[
                ["flat", "Flat grid"],
                ["grouped", "Group by category"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onViewModeChange(value as CatalogLayout)}
                  className={`min-w-[8.5rem] whitespace-nowrap rounded px-3 text-xs font-semibold transition ${
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
