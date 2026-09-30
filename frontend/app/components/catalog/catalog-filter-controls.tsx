"use client";

import { CatalogTaxonOption, PhotoStatus } from "../../lib/api";

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

type CatalogFilterProps = {
  statusFilter: StatusFilter;
  categoryFilter: string;
  takenFrom?: string;
  takenTo?: string;
  categoryOptions: string[];
  hasUnknownCategory: boolean;
  taxonId?: number;
  taxonOptions: CatalogTaxonOption[];
  taxaLoading: boolean;
  taxaError: string | null;
  hasMoreTaxa: boolean;
  onStatusChange: (value: StatusFilter) => void;
  onCategoryChange: (value: string) => void;
  onTakenFromChange: (value?: string) => void;
  onTakenToChange: (value?: string) => void;
  onTaxonFocus: () => void;
  onTaxonChange: (value?: number) => void;
  onLoadMoreTaxa: () => void;
};

export function CatalogTaxonFilter({ taxonId, taxonOptions, taxaLoading, taxaError, hasMoreTaxa, onTaxonFocus, onTaxonChange, onLoadMoreTaxa }: Pick<CatalogFilterProps, "taxonId" | "taxonOptions" | "taxaLoading" | "taxaError" | "hasMoreTaxa" | "onTaxonFocus" | "onTaxonChange" | "onLoadMoreTaxa">) {
  return (
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
              {taxonId && !taxonOptions.some((taxon) => taxon.taxon_id === taxonId) ? (
                <option value={taxonId}>Taxon #{taxonId}</option>
              ) : null}
              {taxonOptions.map((taxon) => (
                <option key={taxon.taxon_id} value={taxon.taxon_id}>
                  {taxon.label} ({taxon.count})
                </option>
              ))}
            </select>
          </label>
          {taxaError ? <p role="alert" className="mt-1 text-xs text-red-700">{taxaError}</p> : null}
          {taxaError ? (
            <button type="button" onClick={onTaxonFocus} className="mt-1 text-xs font-semibold text-red-700 underline">Retry taxa</button>
          ) : hasMoreTaxa ? (
            <button
              type="button"
              disabled={taxaLoading}
              onClick={onLoadMoreTaxa}
              className="mt-1 text-xs font-semibold text-emerald-800 underline disabled:opacity-50"
            >
              {taxaLoading ? "Loading taxa…" : "Load more taxa"}
            </button>
          ) : null}
        </div>
  );
}

export function CatalogStatusFilter({ statusFilter, onStatusChange }: Pick<CatalogFilterProps, "statusFilter" | "onStatusChange">) {
  return (
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
  );
}

export function CatalogCategoryFilter({ categoryFilter, categoryOptions, hasUnknownCategory, onCategoryChange }: Pick<CatalogFilterProps, "categoryFilter" | "categoryOptions" | "hasUnknownCategory" | "onCategoryChange">) {
  return (
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
  );
}

export function CatalogDateFilters({ takenFrom, takenTo, onTakenFromChange, onTakenToChange }: Pick<CatalogFilterProps, "takenFrom" | "takenTo" | "onTakenFromChange" | "onTakenToChange">) {
  return (
      <div className="mt-4 grid gap-3 border-t border-stone-100 pt-4 sm:grid-cols-2 lg:max-w-xl">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Taken from
          </span>
          <input
            type="date"
            value={takenFrom ?? ""}
            max={takenTo}
            onChange={(event) =>
              onTakenFromChange(event.target.value || undefined)
            }
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Taken to
          </span>
          <input
            type="date"
            value={takenTo ?? ""}
            min={takenFrom}
            onChange={(event) =>
              onTakenToChange(event.target.value || undefined)
            }
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          />
        </label>
      </div>
  );
}

