"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PhotographyCalendar from "../components/photography-calendar";
import { usePhotoCalendar } from "../hooks/use-photo-calendar";
import { parseInsightsYear } from "../lib/insights";
import { calendarDayHref, calendarDayLabel, mostActiveDay } from "../lib/photo-calendar";

export default function CalendarBrowser() {
  const params = useSearchParams();
  const router = useRouter();
  const year = parseInsightsYear(params.get("year"));
  const calendar = usePhotoCalendar(year);
  const data = calendar.data;
  const selected = year ?? data?.year;
  const years = Array.from(new Set([...calendar.availableYears, ...(selected ? [selected] : [])])).sort((a, b) => b - a);
  const query = params.toString();
  // Pin the backend's default year without adding a history entry. Reloading or
  // toggling modes then keeps the same year even if newer photos are imported.
  useEffect(() => {
    if (year === undefined && data?.year != null) {
      const next = new URLSearchParams(query);
      next.set("year", String(data.year));
      router.replace(`/timeline?${next}`, { scroll: false });
    }
  }, [year, data?.year, query, router]);

  function selectYear(value: string) {
    const next = new URLSearchParams(query);
    next.set("year", value);
    router.push(`/timeline?${next}`, { scroll: false });
  }
  const mostActive = mostActiveDay(data?.days ?? []);
  return <div className="mt-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h2 className="text-2xl font-semibold">Daily photography calendar</h2>
      <label className="flex items-center gap-3 text-sm font-medium">Capture year
        <select aria-label="Capture year" value={selected ?? ""} disabled={!years.length} onChange={(event) => selectYear(event.target.value)} className="min-h-11 rounded-lg border border-stone-300 bg-white px-3 focus-visible:outline-2 focus-visible:outline-emerald-700 disabled:opacity-60">
          {!selected && <option value="">No capture years</option>}
          {years.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    </div>
    {params.has("year") && year === undefined && <p role="status" className="mt-3 text-sm text-amber-800">Invalid year in URL. Showing the latest capture year.</p>}
    <p className="mt-4 text-sm leading-6 text-stone-600">Photos without capture dates are not included in the calendar. <Link href="/metadata-health" className="font-semibold text-emerald-800 underline underline-offset-2">Open Metadata Health</Link>{data && ` · ${data.unknown_capture_count} undated ${data.unknown_capture_count === 1 ? "photo" : "photos"}.`} Days use camera-local capture dates. Trash is excluded.</p>
    {calendar.loading ? <p role="status" className="py-8 text-sm text-stone-600">Loading photography calendar…</p> : calendar.error ? <div role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"><p>{calendar.error}</p><button type="button" onClick={() => void calendar.retry()} className="mt-3 min-h-11 rounded-lg border border-red-200 bg-white px-4 font-semibold focus-visible:outline-2 focus-visible:outline-red-700">Retry</button></div> : data && <>
      <dl aria-label="Photography activity summary" className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[{ label: "Photos captured this year", value: data.photo_count }, { label: "Active photography days", value: data.active_days }, { label: "Most active day", value: mostActive ? <Link href={calendarDayHref(mostActive.date)} aria-label={`Most active day: ${calendarDayLabel(mostActive.date, mostActive.photo_count)}`} className="text-base underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-emerald-700">{calendarDayLabel(mostActive.date, mostActive.photo_count)}</Link> : "None" }, { label: "Average Photos per active day", value: data.active_days ? new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(data.photo_count / data.active_days) : 0 }].map((metric) => <div key={metric.label} className="min-w-0 rounded-xl border border-stone-200 bg-white p-4 shadow-sm"><dt className="text-sm font-medium text-stone-600">{metric.label}</dt><dd className="mt-2 text-2xl font-semibold text-emerald-950">{metric.value}</dd></div>)}
      </dl>
      {data.photo_count === 0 && <div className="mt-5 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center"><h3 className="text-xl font-semibold">{data.year === null ? "No photos with capture dates yet" : "No active photos in this year"}</h3><p className="mt-2 text-sm text-stone-600">{data.year === null ? "Import Photos or correct missing capture dates to start exploring." : "Choose another capture year to explore your archive."}</p></div>}
      {data.year !== null && <PhotographyCalendar year={data.year} days={data.days} maximum={data.max_daily_count} />}
      <p className="mt-5 text-xs text-stone-600">Counts represent Photos. Ties for the most active day use the earliest date.</p>
    </>}
  </div>;
}
