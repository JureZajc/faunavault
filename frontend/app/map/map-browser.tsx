"use client";

import Link from "next/link";
import { useState } from "react";
import EventListContext from "../components/events/event-list-context";
import ArchiveNavigation from "../components/archive-navigation";
import {
  CatalogCategoryFilter, CatalogDateFilters, CatalogStatusFilter,
  CatalogTaxonFilter, UNKNOWN_CATEGORY_VALUE,
} from "../components/catalog/catalog-filter-controls";
import { ArchivePhotoMap } from "../components/maps/map-boundaries";
import { useCatalogFacets } from "../hooks/use-catalog-facets";
import { useCatalogQueryState } from "../hooks/use-catalog-query-state";
import { useCatalogTaxa } from "../hooks/use-catalog-taxa";
import { usePhotoMapPoints } from "../hooks/use-photo-map-points";
import { hasCurationFilters, mapCatalogHref, mapListHref } from "../lib/catalog-query";

export default function MapBrowser({ focusPhotoId }: { focusPhotoId: number | null }) {
  const query = useCatalogQueryState("map");
  const state = query.catalogState;
  const unsupportedSearch = Boolean(state.search);
  const unsupportedCuration = hasCurationFilters(state);
  const unsupportedImport = Boolean(state.import_session_id);
  const unsupported = unsupportedSearch || unsupportedCuration || unsupportedImport;
  const locations = usePhotoMapPoints(state, unsupported);
  const options = useCatalogFacets();
  const taxa = useCatalogTaxa(state.taxon_id);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const taxonOptions = Array.from(new Map(
    (taxa.selected ? [taxa.selected, ...taxa.items] : taxa.items)
      .map((taxon) => [taxon.taxon_id, taxon]),
  ).values());
  const summary = [
    state.event_id !== undefined ? `Trip/Event #${state.event_id}` : null,
    state.uncategorized ? "Category: Unknown" : state.category ? `Category: ${state.category}` : null,
    state.taxon_id ? `Taxon: ${taxonOptions.find((taxon) => taxon.taxon_id === state.taxon_id)?.label ?? `#${state.taxon_id}`}` : null,
    state.status ? `Status: ${state.status.replaceAll("_", " ")}` : null,
    state.taken_from ? `Taken from ${state.taken_from}` : null,
    state.taken_to ? `Taken to ${state.taken_to}` : null,
    unsupportedCuration ? "Unsupported Favorite/Rating filters or Culling filters" : null,
    unsupportedSearch ? `Unsupported search: ${state.search}` : null,
    unsupportedImport ? "Unsupported Import Session filter" : null,
  ].filter(Boolean);
  const ready = !locations.isLoading && !locations.error && !unsupported;
  const count = locations.points?.length ?? 0;
  const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50";

  return (
    <main className="min-h-screen min-w-0 overflow-x-hidden bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <ArchiveNavigation active="map" />
          <p className="text-sm text-stone-500 lg:text-right">Browse active photos by capture location</p>
        </div>
        {state.event_id !== undefined ? <div className="mt-5"><EventListContext id={String(state.event_id)} /></div> : null}
        <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Archive geography</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold">Photo Map</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
                Only active photos matching your filters with complete location data appear here.
                Nearby photos are grouped until you zoom in. List includes matching photos without GPS.
              </p>
            </div>
            {ready ? <p className="shrink-0 text-sm font-medium text-stone-600">{count} mapped {count === 1 ? "photo" : "photos"}</p> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" aria-expanded={filtersOpen} aria-controls="map-filters" onClick={() => setFiltersOpen(!filtersOpen)} className={buttonClass}>Filters</button>
            {summary.length ? <button type="button" onClick={query.clearFilters} className={buttonClass}>Clear filters</button> : null}
            <Link href={mapListHref(state)} className={buttonClass}>View in List</Link>
          </div>
          <p aria-label="Active map filters" className="mt-3 text-sm text-stone-600">{summary.length ? summary.join(" · ") : "All active photos"}</p>
          <div id="map-filters" hidden={!filtersOpen || unsupported} className="mt-4 border-t border-stone-100 pt-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <CatalogCategoryFilter categoryFilter={state.uncategorized ? UNKNOWN_CATEGORY_VALUE : state.category ?? "all"}
                categoryOptions={options.facets?.categories.map((item) => item.value) ?? []}
                hasUnknownCategory={(options.facets?.uncategorized_count ?? 0) > 0}
                onCategoryChange={(value) => query.setCategory(value === "all" || value === UNKNOWN_CATEGORY_VALUE ? undefined : value, value === UNKNOWN_CATEGORY_VALUE)} />
              <CatalogTaxonFilter taxonId={state.taxon_id} taxonOptions={taxonOptions}
                taxaLoading={taxa.isLoading} taxaError={taxa.error} hasMoreTaxa={taxa.hasMore}
                onTaxonFocus={() => { if ((!taxa.isLoaded || taxa.error) && !taxa.isLoading) void taxa.load(); }}
                onTaxonChange={query.setTaxon} onLoadMoreTaxa={() => void taxa.loadMore()} />
              <CatalogStatusFilter statusFilter={state.status ?? "all"} onStatusChange={(value) => query.setStatus(value === "all" ? undefined : value)} />
            </div>
            <CatalogDateFilters takenFrom={state.taken_from} takenTo={state.taken_to} onTakenFromChange={query.setTakenFrom} onTakenToChange={query.setTakenTo} />
            {options.error ? <p role="alert" className="mt-3 text-sm text-red-700">{options.error}. <button type="button" onClick={() => void options.retry()} className="underline">Retry filter options</button></p> : null}
          </div>
        </header>
        <section aria-labelledby="archive-map-heading" className="mt-5 min-w-0" aria-busy={locations.isLoading}>
          <h2 id="archive-map-heading" className="sr-only">Interactive archive map</h2>
          {unsupported ? (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
              <p>{unsupportedImport ? "Import Session filters are not supported on Map. Remove unsupported filters to view locations, or use View in List." : unsupportedCuration ? "Favorite/Rating filters are not supported on Map. Culling filters are also unsupported. Remove unsupported filters to view locations, or use View in List." : "Text search is not supported on Map. Remove it to view locations, or use View in List."}</p>
              <button type="button" onClick={() => query.setStatus(state.status)} className={`${buttonClass} mt-3`}>{unsupportedCuration || unsupportedImport ? "Remove unsupported filters" : "Remove text search"}</button>
            </div>
          ) : locations.isLoading ? (
            <div role="status" className="grid h-[clamp(24rem,calc(100dvh-13rem),56rem)] place-items-center rounded-lg border border-stone-200 bg-stone-200 text-sm text-stone-600">Loading photo locations…</div>
          ) : locations.error ? (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              <p>{locations.error}</p>
              <button type="button" onClick={() => void locations.retry()} className={`${buttonClass} mt-3`}>Retry</button>
            </div>
          ) : count === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white px-4 py-16 text-center">
              <h2 className="text-xl font-semibold">No matching photos with location data</h2>
              <p className="mt-2 text-sm text-stone-500">Use View in List to see all matching photos, including those without GPS.</p>
            </div>
          ) : null}
          {locations.hasMap ? <div hidden={!ready || count === 0}>
            <ArchivePhotoMap points={locations.points ?? []} focusPhotoId={focusPhotoId} mapHref={mapCatalogHref(state)} />
          </div> : null}
        </section>
      </div>
    </main>
  );
}
