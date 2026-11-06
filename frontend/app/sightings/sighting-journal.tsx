"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import PhotoThumbnailPreview from "../components/photo-thumbnail-preview";
import { buttonStyle, inputStyle, LocalSpeciesPicker, SightingError, SightingPagination } from "../components/sightings/sighting-controls";
import { useSightingResource } from "../hooks/use-sighting-resource";
import { getSightings, SightingFilters, SightingTaxon } from "../lib/api";
import { formatCameraLocalDate } from "../lib/photo-metadata";
import { sightingMapHref } from "../lib/sighting-map-query";
import { sightingName, taxonLabel } from "../lib/sightings";

export default function SightingJournal() {
  const [filters, setFilters] = useState<SightingFilters>({ page: 1, sort: "newest" });
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [taxon, setTaxon] = useState<SightingTaxon | null>(null);
  const load = useCallback((signal: AbortSignal) => getSightings(filters, signal), [filters]);
  const { data, error, retry } = useSightingResource(load);
  const invalidRange = !!(dateFrom && dateTo && dateFrom > dateTo);

  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl space-y-5 px-3 py-8 sm:px-6">
      <header>
        <h1 className="text-3xl font-semibold">Wildlife Sightings Journal</h1>
        <p className="mt-2 text-stone-600">Record encounters in the field and link the photos that document each one.</p>
        <div className="flex flex-wrap gap-x-4 font-semibold text-emerald-900 underline">
          <Link href="/life-list" className="inline-flex min-h-11 items-center">Explore your Life List</Link>
          <Link href={sightingMapHref(filters)} className="inline-flex min-h-11 items-center">View Sightings Map</Link>
        </div>
      </header>
      <ArchiveNavigation active="sightings" />
      <section aria-label="Sighting filters" className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!invalidRange) setFilters({ ...filters, date_from: dateFrom, date_to: dateTo, page: 1 });
        }} className="grid items-end gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <label className="text-sm font-semibold">Sort sightings
            <select className={inputStyle} value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value === "oldest" ? "oldest" : "newest", page: 1 })}>
              <option value="newest">Newest first</option><option value="oldest">Oldest first</option>
            </select>
          </label>
          <label className="text-sm font-semibold">From date
            <input className={inputStyle} type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label className="text-sm font-semibold">Through date
            <input className={inputStyle} type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={invalidRange} className={buttonStyle}>Apply dates</button>
            {(dateFrom || dateTo || filters.date_from || filters.date_to) && <button type="button" className={buttonStyle} onClick={() => {
              setDateFrom(""); setDateTo(""); setFilters({ ...filters, date_from: undefined, date_to: undefined, page: 1 });
            }}>Clear dates</button>}
          </div>
        </form>
        {invalidRange && <SightingError message="From date must be on or before through date." />}
        <LocalSpeciesPicker value={taxon} emptyLabel="All species and unidentified sightings" onChange={(value) => {
          setTaxon(value); setFilters({ ...filters, taxon_id: value?.id, page: 1 });
        }} />
      </section>
      {error ? <SightingError message={error} retry={retry} /> : !data ? <p role="status">Loading sightings…</p> : <>
        <dl aria-label="Journal totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            ["Total recorded", data.totals.recorded],
            ["In date range", data.totals.in_date_range],
            ["Verified species", data.totals.verified],
            ["Unidentified", data.totals.unidentified],
          ] as const).map(([label, count]) => <div key={label} className="rounded-lg border border-stone-200 bg-white p-3">
            <dt className="text-sm text-stone-600">{label}</dt><dd className="text-2xl font-semibold tabular-nums">{count}</dd>
          </div>)}
        </dl>
        {data.items.length ? <>
          <p role="status" className="text-sm text-stone-600">{data.total} matching {data.total === 1 ? "sighting" : "sightings"}</p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.items.map((item) => <li key={item.id} className="min-w-0">
              <Link href={`/sightings/${item.id}`} className="block h-full rounded-lg border border-stone-200 bg-white p-3 hover:border-emerald-600 focus-visible:outline-2 focus-visible:outline-emerald-800">
                {item.preview ? <PhotoThumbnailPreview key={item.preview.id} preview={item.preview} /> : <div className="grid aspect-[4/3] place-items-center rounded-md bg-stone-100 text-sm text-stone-600">No active photos</div>}
                <h2 className="mt-2 break-words text-lg font-semibold text-emerald-950">{sightingName(item)}</h2>
                {item.subject_label && item.taxon && <p className="break-words text-sm text-stone-700">{taxonLabel(item.taxon)}</p>}
                <p className="text-sm text-stone-600"><time dateTime={item.observed_at}>{formatCameraLocalDate(item.observed_at)}</time></p>
                {item.location_label && <p className="break-words text-sm text-stone-600">{item.location_label}</p>}
                <p className="mt-1 text-sm font-medium">{item.active_photo_count} active {item.active_photo_count === 1 ? "photo" : "photos"}</p>
              </Link>
            </li>)}
          </ul>
        </> : <div className="rounded-lg border border-stone-200 bg-white p-6">
          <h2 className="text-lg font-semibold">{data.totals.recorded ? "No matching sightings" : "No sightings recorded yet"}</h2>
          <p className="mt-1 text-sm text-stone-600">{data.totals.recorded ? "Try changing the date range or species." : "Select photos in List and choose Create Sighting to record your first encounter."}</p>
          {!data.totals.recorded && <Link className="mt-2 inline-flex min-h-11 items-center underline" href="/">Open List</Link>}
        </div>}
        <SightingPagination page={data.page} totalPages={data.total_pages} label="Sighting journal pages" onPage={(page) => setFilters({ ...filters, page })} />
      </>}
    </div>
  </main>;
}
