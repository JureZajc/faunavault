"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import LifeListCard from "../components/life-list/life-list-card";
import { buttonStyle, inputStyle, SightingError, SightingPagination } from "../components/sightings/sighting-controls";
import { useSightingResource } from "../hooks/use-sighting-resource";
import { getLifeList, type LifeListFilters, type LifeListPage } from "../lib/api";

function positiveInteger(value: string | null, max: number) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number >= 1 && number <= max ? number : undefined;
}

function SummaryCards({ year, summary }: Pick<LifeListPage, "year" | "summary">) {
  const cards = [
    ["All-time verified taxa", summary.all_time_taxa],
    [year === null ? "Verified taxa seen in selected year" : `Verified taxa seen in ${year}`, summary.seen_taxa],
    [year === null ? "Verified taxa first recorded in selected year" : `Verified taxa first recorded in ${year}`, summary.new_taxa],
    ["Sightings in this view", summary.scope_sightings],
  ] as const;
  return (
    <dl aria-label="Life List totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map(([label, count]) => (
        <div key={label} className="rounded-lg border border-stone-200 bg-white p-3">
          <dt className="text-sm text-stone-600">{label}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{count?.toLocaleString() ?? <span className="text-sm font-normal">Select a year</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function LifeListBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const year = positiveInteger(params.get("year"), 9999);
  const mode = year !== undefined && params.get("mode") === "new" ? "new" : "seen";
  const requestedSort = params.get("sort");
  const sort = requestedSort === "first_observed" || requestedSort === "most_observed" ? requestedSort : "name";
  const search = (params.get("search") ?? "").trim().slice(0, 200);
  const page = positiveInteger(params.get("page"), 2 ** 31 - 1) ?? 1;

  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const load = useCallback(async (signal: AbortSignal) => {
    const result = await getLifeList({ year, mode, search, sort, page }, signal);
    if (!signal.aborted) setAvailableYears(result.available_years);
    return result;
  }, [year, mode, search, sort, page]);
  const { data, error, retry } = useSightingResource(load);
  const years = year !== undefined && !availableYears.includes(year)
    ? [...availableYears, year].sort((a, b) => b - a)
    : availableYears;

  function changeFilter(key: keyof LifeListFilters, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    if (key === "year" && !value) next.delete("mode");
    if (next.toString() !== params.toString()) {
      router.push(next.size ? `/life-list?${next}` : "/life-list", { scroll: false });
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl space-y-5 px-3 py-8 sm:px-6">
        <header>
          <h1 className="text-3xl font-semibold">Wildlife Life List</h1>
          <p className="mt-2 text-stone-600">Explore the verified species and subspecies recorded in your Sightings Journal.</p>
        </header>
        <ArchiveNavigation active="life-list" />
        <section aria-label="Life List filters" className="grid items-start gap-4 rounded-lg border border-stone-200 bg-white p-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm font-semibold">
            Observation year
            <select className={inputStyle} value={year ?? ""} onChange={(event) => changeFilter("year", event.target.value)}>
              <option value="">All time</option>
              {years.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <fieldset disabled={year === undefined} className="min-w-0 text-sm disabled:opacity-60">
            <legend className="font-semibold">Yearly view</legend>
            <div className="flex flex-wrap gap-x-3">
              <label className="inline-flex min-h-11 items-center gap-2">
                <input type="radio" name="life-list-mode" checked={mode === "seen"} onChange={() => changeFilter("mode", "")} />
                Seen
              </label>
              <label className="inline-flex min-h-11 items-center gap-2">
                <input type="radio" name="life-list-mode" checked={mode === "new"} onChange={() => changeFilter("mode", "new")} />
                First recorded this year
              </label>
            </div>
          </fieldset>
          <form className="flex items-end gap-2" onSubmit={(event) => {
            event.preventDefault();
            changeFilter("search", String(new FormData(event.currentTarget).get("search") ?? "").trim());
          }}>
            <label className="min-w-0 flex-1 text-sm font-semibold">
              Search names
              <input key={search} name="search" type="search" maxLength={200} defaultValue={search} className={inputStyle} />
            </label>
            <button type="submit" className={buttonStyle}>Search</button>
          </form>
          <label className="text-sm font-semibold">
            Sort taxa
            <select className={inputStyle} value={sort} onChange={(event) => changeFilter("sort", event.target.value)}>
              <option value="name">Name</option>
              <option value="first_observed">First observed (earliest)</option>
              <option value="most_observed">Most sightings (all time)</option>
            </select>
          </label>
        </section>
        {error ? <SightingError message={error} retry={retry} /> : !data ? <p role="status">Loading Life List…</p> : (
          <>
            <SummaryCards year={data.year} summary={data.summary} />
            {data.items.length > 0 ? (
              <>
                <p role="status" className="text-sm text-stone-600">
                  {data.total.toLocaleString()} matching {data.total === 1 ? "verified taxon" : "verified taxa"}. Dates and counts on cards cover all time.
                </p>
                <ul aria-label="Verified taxa" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {data.items.map((item) => <li key={item.taxon_id} className="min-w-0"><LifeListCard item={item} /></li>)}
                </ul>
                <SightingPagination page={data.page} totalPages={data.total_pages} label="Life List pages" onPage={(next) => changeFilter("page", next === 1 ? "" : String(next))} />
              </>
            ) : (
              <div className="rounded-lg border border-stone-200 bg-white p-6">
                <h2 className="text-lg font-semibold">{data.total ? "This page is unavailable" : data.summary.all_time_taxa ? "No matching verified taxa" : "No verified taxa recorded yet"}</h2>
                {data.total ? <button type="button" className={`mt-2 ${buttonStyle}`} onClick={() => changeFilter("page", "")}>Go to first page</button>
                  : data.summary.all_time_taxa ? <p className="mt-1 text-sm text-stone-600">Try changing the year, view, or search.</p>
                    : <Link href="/sightings" className="inline-flex min-h-11 items-center text-emerald-900 underline">Open the Sightings Journal</Link>}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
