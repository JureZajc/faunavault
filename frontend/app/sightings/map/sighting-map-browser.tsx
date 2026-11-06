"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import ArchiveNavigation from "../../components/archive-navigation";
import AreaCoordinateForm from "../../components/catalog/area-coordinate-form";
import { SightingMap } from "../../components/maps/map-boundaries";
import { buttonStyle, inputStyle, LocalSpeciesPicker, SightingError } from "../../components/sightings/sighting-controls";
import { useSightingResource } from "../../hooks/use-sighting-resource";
import { getSightingMap, SightingMapPoint, SightingTaxon } from "../../lib/api";
import { AreaBounds, areaSummary, EMPTY_BOUNDS, hasArea } from "../../lib/geographic-bounds";
import { readSightingMapQuery, sightingDateError, SightingMapFilters, sightingMapHref } from "../../lib/sighting-map-query";

const NO_POINTS: SightingMapPoint[] = [];

function DateFilters({ from = "", through = "", onApply, onClear }: {
  from?: string;
  through?: string;
  onApply: (from: string, through: string) => void;
  onClear: () => void;
}) {
  const [dateFrom, setDateFrom] = useState(from);
  const [dateTo, setDateTo] = useState(through);
  const error = sightingDateError(dateFrom, dateTo);
  return <form className="space-y-2" onSubmit={(event) => {
    event.preventDefault();
    if (!error) onApply(dateFrom, dateTo);
  }}>
    <div className="grid items-end gap-3 sm:grid-cols-3">
      <label className="text-sm font-semibold">From date
        <input className={inputStyle} type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
      </label>
      <label className="text-sm font-semibold">Through date
        <input className={inputStyle} type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonStyle} disabled={Boolean(error)}>Apply dates</button>
        <button type="button" className={buttonStyle} onClick={() => {
          setDateFrom(""); setDateTo(""); onClear();
        }}>Clear filters</button>
      </div>
    </div>
    {error && <SightingError message={error} />}
  </form>;
}

export default function SightingMapBrowser() {
  const router = useRouter();
  const search = useSearchParams().toString();
  const { filters, error: filterError, areaError } = useMemo(() => readSightingMapQuery(new URLSearchParams(search)), [search]);
  const load = useCallback((signal: AbortSignal) => filterError ? Promise.resolve(undefined) : getSightingMap(filters, signal), [filterError, filters]);
  const { data, error, retry } = useSightingResource(load);
  const [pickedTaxon, setPickedTaxon] = useState<SightingTaxon | null>(null);
  const area = hasArea(filters) && !areaError ? filters as AreaBounds : undefined;
  const points = data?.points ?? NO_POINTS;
  const taxon = pickedTaxon?.id === filters.taxon_id ? pickedTaxon : null;
  const taxonPoint = filters.taxon_id ? points[0] : undefined;
  const taxonSummary = filters.taxon_id ? taxonPoint?.common_name?.trim() || taxonPoint?.scientific_name || `Local species #${filters.taxon_id}` : undefined;
  const focusId = filters.focus;
  const mapped = data ? data.total_matching - data.without_location_count : 0;

  function navigate(next: SightingMapFilters) {
    const href = sightingMapHref(next);
    if (href !== `/sightings/map${search ? `?${search}` : ""}`) router.push(href, { scroll: false });
  }

  function changeFilters(next: SightingMapFilters) {
    navigate({ ...filters, ...next, focus: undefined });
  }

  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl space-y-5 px-3 py-8 sm:px-6">
      <header>
        <h1 className="text-3xl font-semibold">Wildlife Sightings Map</h1>
        <p className="mt-2 text-stone-600">Explore recorded encounters by their observation date and Sighting coordinates.</p>
        <nav aria-label="Related archive views" className="flex flex-wrap gap-x-4 font-semibold text-emerald-900 underline">
          <Link href="/sightings" className="inline-flex min-h-11 items-center">Sightings Journal</Link>
          <Link href="/life-list" className="inline-flex min-h-11 items-center">Life List</Link>
          <Link href="/map" className="inline-flex min-h-11 items-center">Photo Map</Link>
        </nav>
      </header>
      <ArchiveNavigation active="sightings" />
      <section aria-label="Sighting map filters" className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
        <DateFilters key={JSON.stringify([filters.date_from, filters.date_to])} from={filters.date_from} through={filters.date_to}
          onApply={(date_from, date_to) => changeFilters({ date_from, date_to })}
          onClear={() => navigate({})} />
        <LocalSpeciesPicker value={taxon} selectedLabel={taxonSummary} emptyLabel="All species and unidentified sightings" onChange={(value) => {
          setPickedTaxon(value); changeFilters({ taxon_id: value?.id });
        }} />
        <details className="border-t border-stone-200 pt-2">
          <summary className="cursor-pointer py-2 text-sm font-semibold">Geographic area coordinates</summary>
          <p id="sighting-area-instructions" className="text-sm text-stone-600">Use the visible map area or enter coordinates. West greater than East selects across the antimeridian.</p>
          <AreaCoordinateForm value={filters} instructionsId="sighting-area-instructions" onApply={(bounds) => changeFilters(bounds)} />
        </details>
        {hasArea(filters) && <div className="flex flex-wrap items-center gap-3 text-sm">
          <p aria-label="Selected geographic area">{areaSummary(filters)}</p>
          <button type="button" className={buttonStyle} onClick={() => changeFilters(EMPTY_BOUNDS)}>Clear area</button>
        </div>}
      </section>

      <section aria-label="Sighting map results" className="space-y-3">
        {filterError || error ? <SightingError message={filterError || error!} retry={filterError ? undefined : retry} /> : !data ? <p role="status">Loading sightings…</p> : <>
          <ul aria-label="Sighting map counts" aria-live="polite" className="flex flex-wrap gap-3 text-sm font-semibold text-stone-700">
            <li>{data.total_matching} matching {data.total_matching === 1 ? "sighting" : "sightings"}</li>
            <li>{mapped} mapped {mapped === 1 ? "encounter" : "encounters"}{area ? " in this area" : ""}</li>
            <li>{data.without_location_count} without GPS</li>
          </ul>
          {data.without_location_count > 0 && <p className="text-sm text-stone-600">
            Sightings without valid coordinates stay in the Journal. {area && "The missing GPS count covers all sightings matching the date and species filters."}
          </p>}
          {data.truncated && <p role="status" className="rounded-md bg-amber-50 p-3 text-sm font-semibold text-amber-950">
            Showing {points.length} of {mapped} mapped encounters. Refine the date or species filters, or zoom in and choose Search this map area.
          </p>}
          {focusId !== undefined && !points.some((point) => point.id === focusId) && <p role="status" className="text-sm text-stone-700">
            The focused Sighting has no mapped location in these results. <Link href={`/sightings/${focusId}`} className="underline">Check Sighting details</Link>
          </p>}
          {!points.length && <div className="rounded-lg border border-stone-200 bg-white p-5">
            <h2 className="text-lg font-semibold">No matching sightings with GPS</h2>
            <p className="text-sm text-stone-600">Change the filters or open the Journal to review recorded encounters.</p>
          </div>}
        </>}
        <SightingMap points={points} focusId={focusId} area={area} onAreaSelect={(bounds) => changeFilters(bounds)} />
      </section>
    </div>
  </main>;
}
