"use client";

import Link from "next/link";
import { useInsights } from "../hooks/use-insights";
import { InsightsResponse } from "../lib/api";
import { insightsCount, insightsDifference, insightsListHref, insightsPercent } from "../lib/insights";
import { InsightsPanel } from "./insights-charts";

// Mounted only after an explicit, valid comparison selection. The primary
// response is reused; changing the comparison never refetches the primary.
export default function YearComparison({ primary, year }: { primary: InsightsResponse; year: number }) {
  const comparison = useInsights(year);
  const baseline = comparison.data;
  const metrics = baseline ? [
    ["Active photos", primary.overview.total_photos, baseline.overview.total_photos, false],
    ["Verified species", primary.overview.verified_species, baseline.overview.verified_species, false],
    ["Favorite photos", primary.overview.favorites, baseline.overview.favorites, false],
    ["Pick photos", primary.overview.picks, baseline.overview.picks, false],
    ["Reject photos", primary.overview.rejects, baseline.overview.rejects, false],
    ["GPS coverage", primary.overview.gps.percentage, baseline.overview.gps.percentage, true],
  ] as const : [];
  return <div className="mt-6"><InsightsPanel title="Year comparison" description="Primary year minus comparison year. Verified species counts distinct linked verified taxa at species rank. Photo totals describe images, not wildlife observations or new species observations.">
    {comparison.loading ? <p role="status">Loading year comparison…</p> : comparison.error ? <div role="alert">
      <p>Could not load year comparison</p>
      <button type="button" onClick={() => void comparison.retry()} className="mt-3 min-h-11 rounded-lg border border-stone-300 px-4 text-sm font-semibold">Retry comparison</button>
    </div> : baseline && <>
      <div className="mb-5 flex flex-wrap gap-4 text-sm">
        <Link className="inline-flex min-h-11 items-center text-emerald-800 underline" href={insightsListHref(primary.year!)}>Browse {primary.year} photos</Link>
        <Link className="inline-flex min-h-11 items-center text-emerald-800 underline" href={insightsListHref(year)}>Browse {year} photos</Link>
      </div>
      {baseline.overview.total_photos === 0 && <p role="status" className="mb-4 text-sm text-stone-500">No active photos in comparison year {year}. Relative changes have a zero baseline (N/A).</p>}
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {metrics.map(([label, value, previous, points]) => <div key={label} className="min-w-0 rounded-lg bg-stone-50 p-4">
          <dt className="font-medium">{label}</dt>
          <dd className="mt-2 text-sm text-stone-600">{primary.year}: {points ? insightsPercent(value) : insightsCount(value)}</dd>
          <dd className="mt-1 text-sm text-stone-600">{year}: {points ? insightsPercent(previous) : insightsCount(previous)}</dd>
          <dd className="mt-2 text-sm font-semibold tabular-nums">Difference: {insightsDifference(value, previous, points)}</dd>
        </div>)}
      </dl>
    </>}
  </InsightsPanel></div>;
}
