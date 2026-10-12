"use client";

import { useRouter, useSearchParams } from "next/navigation";
import ArchiveNavigation from "../components/archive-navigation";
import { useInsights } from "../hooks/use-insights";
import { parseInsightsYear } from "../lib/insights";
import { CategoryBreakdown, ClassificationBreakdown, InsightsSummaryCards, LocationCoverage, PhotographyActivityChart, TopSpeciesChart } from "./insights-charts";

export default function InsightsBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const year = parseInsightsYear(params.get("year"));
  const insights = useInsights(year);
  const data = insights.data;
  const availableYears = Array.from(new Set([...insights.availableYears, ...(year === undefined ? [] : [year])])).sort((a, b) => b - a);

  function selectYear(value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set("year", value); else next.delete("year");
    router.push(next.size ? `/insights?${next}` : "/insights", { scroll: false });
  }

  return <main className="min-h-screen min-w-0 bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <ArchiveNavigation active="insights" />
      <header className="mt-6 flex flex-col gap-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6 md:flex-row md:items-center md:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Your archive, in perspective</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Wildlife Insights</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">A closer look at what you photograph, when you venture out, and how your archive grows.</p>
        </div>
        <div className="shrink-0"><label htmlFor="insights-year" className="mb-2 block text-sm font-medium text-stone-600">Capture year</label>
          <select id="insights-year" value={year ?? ""} onChange={(event) => selectYear(event.target.value)} className="min-h-11 w-full rounded-lg border border-stone-300 bg-white px-3 text-sm focus-visible:outline-2 focus-visible:outline-emerald-700 md:w-40">
            <option value="">All Time</option>{availableYears.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </header>
      <p className="my-5 text-sm leading-6 text-stone-500">{year === undefined ? "All Time includes active photos with and without capture dates." : `${year} includes only active photos captured in that year; undated photos are excluded.`} All percentages use this period’s active photo total. Trash is excluded.</p>
      {params.has("year") && year === undefined && <p role="status" className="mb-5 text-sm text-amber-800">Invalid year in URL. Showing All Time.</p>}
      {insights.loading ? <div role="status" className="space-y-4"><p className="text-sm text-stone-500">Loading Wildlife Insights…</p><div className="h-44 animate-pulse rounded-xl bg-white" /></div> : insights.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700"><p>{insights.error}</p><button type="button" onClick={() => void insights.retry()} className="mt-3 min-h-11 rounded-lg border border-red-200 bg-white px-4 font-semibold">Retry</button></div> : data && <>
        <InsightsSummaryCards overview={data.overview} year={year} />
        {data.overview.total_photos === 0 && <div className="my-5 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center"><h2 className="text-xl font-semibold">No active photos{year === undefined ? " yet" : " in this year"}</h2><p className="mt-2 text-sm text-stone-500">{year === undefined ? "Import photos to start exploring your archive." : "Choose another year or All Time to explore your archive."}</p></div>}
        <div className="mt-6 grid items-start gap-5 lg:grid-cols-2"><PhotographyActivityChart data={data} /><TopSpeciesChart data={data} /><CategoryBreakdown data={data} /><ClassificationBreakdown data={data} /><LocationCoverage data={data} /></div>
      </>}
    </div>
  </main>;
}
