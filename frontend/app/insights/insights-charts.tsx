import Link from "next/link";
import type { ReactNode } from "react";
import { InsightsDistribution, InsightsOverview, InsightsResponse, PhotoStatus } from "../lib/api";
import { mapCatalogHref } from "../lib/catalog-query";
import { insightsCount as count, insightsPercent as percent, insightsListHref, insightsYearRange } from "../lib/insights";
import { timelineMonthHref, timelineMonthName } from "../lib/photo-timeline";

const linkClass = "block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700 hover:text-emerald-800";

export function InsightsPanel({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
    <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
    {description && <p className="mt-2 text-sm leading-6 text-stone-500">{description}</p>}
    <div className="mt-5">{children}</div>
  </section>;
}

export function InsightsSummaryCards({ overview, year }: { overview: InsightsOverview; year?: number }) {
  const metrics = [
    { label: "Active photos", value: overview.total_photos, note: "Excludes Trash", href: insightsListHref(year) },
    { label: "Verified species", value: overview.verified_species, note: "Distinct linked taxa at species rank" },
    { label: "Photos with GPS", value: overview.gps.known, note: `${percent(overview.gps.percentage)} of active photos` },
    { label: "Known capture dates", value: overview.capture_dates.known, note: `${percent(overview.capture_dates.percentage)} of active photos` },
    { label: "Favorite photos", value: overview.favorites, note: "Personal favorites", href: insightsListHref(year, { favorites_only: true }) },
    { label: "Pick photos", value: overview.picks, note: "Culling decision: Pick", href: insightsListHref(year, { culling_state: "pick" }) },
    { label: "Reject photos", value: overview.rejects, note: "Active photos marked Reject", href: insightsListHref(year, { culling_state: "reject" }) },
    { label: "Undated photos", value: overview.capture_dates.missing, note: year === undefined ? "Included in All Time" : "Excluded by capture-year filter" },
  ];
  return <dl aria-label="Archive summary" className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
    {metrics.map((metric) => <div key={metric.label} className="min-w-0 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <dt className="text-sm font-medium text-stone-600">{metric.href ? <Link href={metric.href} className={linkClass}>{metric.label}</Link> : metric.label}</dt>
      <dd className="mt-2 text-3xl font-semibold tracking-tight text-emerald-950">{count(metric.value)}</dd>
      <dd className="mt-2 text-xs leading-5 text-stone-500">{metric.note}</dd>
    </div>)}
  </dl>;
}

type BarRow = { key: string; label: string; detail?: string; photoCount: number; percentage?: number; href?: string };

// Semantic lists are the textual chart equivalent. Decorative bars carry no extra
// screen-reader content; every value and link is available without color or a mouse.
function PhotoBars({ rows }: { rows: BarRow[] }) {
  const maximum = Math.max(1, ...rows.map((row) => row.photoCount));
  return <ul className="space-y-4">
    {rows.map((row) => {
      const content = <>
        <div className="flex min-h-11 items-center justify-between gap-3 text-sm">
          <span className="min-w-0 break-words font-medium">{row.label}{row.detail && <span className="mt-0.5 block text-xs font-normal italic text-stone-500">{row.detail}</span>}</span>
          <span className="shrink-0 text-right tabular-nums text-stone-600">{count(row.photoCount)} {row.photoCount === 1 ? "photo" : "photos"}{row.percentage !== undefined && <span className="ml-2 text-xs text-stone-500">{percent(row.percentage)}</span>}</span>
        </div>
        <div aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-stone-100"><div className="h-full rounded-full bg-emerald-600" style={{ width: `${100 * row.photoCount / maximum}%` }} /></div>
      </>;
      return <li key={row.key}>{row.href ? <Link href={row.href} className={linkClass}>{content}</Link> : <div>{content}</div>}</li>;
    })}
  </ul>;
}

export function PhotographyActivityChart({ data }: { data: InsightsResponse }) {
  const monthly = data.year !== null;
  return <InsightsPanel title="Photography activity" description={monthly ? `Monthly photo counts · ${data.year} · camera-local capture dates` : "Yearly photo counts · select a capture year to see all twelve months"}>
    {monthly ? <MonthlyPhotoBars data={data} /> : data.yearly.length ? <PhotoBars rows={data.yearly.map((item) => ({
      key: String(item.period), label: String(item.period), photoCount: item.photo_count,
      href: insightsListHref(item.period, { sort: "captured_at" }),
    }))} /> : <p className="text-sm text-stone-500">No photos with capture dates yet.</p>}
    <p className="mt-5 border-t border-stone-100 pt-4 text-xs leading-5 text-stone-500">{count(data.overview.capture_dates.missing)} photos without capture dates in this period. Import dates are never used. Choose a bar to open List.</p>
  </InsightsPanel>;
}

function MonthlyPhotoBars({ data }: { data: InsightsResponse }) {
  const maximum = Math.max(1, ...data.monthly.map((item) => item.photo_count));
  return <ul aria-label="Monthly photo counts" className="grid grid-cols-6 gap-x-2 gap-y-5 sm:grid-cols-12">
    {data.monthly.map((item) => {
      const name = timelineMonthName(item.period);
      const label = `${count(item.photo_count)} ${item.photo_count === 1 ? "photo" : "photos"}`;
      return <li key={item.period} className="min-w-0"><Link href={timelineMonthHref(data.year!, item.period)} aria-label={`${name} ${data.year}: ${label}`} className={`${linkClass} text-center`}>
        <span className="block pb-2 text-xs tabular-nums text-stone-600">{count(item.photo_count)}<span className="sr-only"> {item.photo_count === 1 ? "photo" : "photos"}</span></span>
        <span aria-hidden="true" className="flex h-28 items-end overflow-hidden rounded-t bg-stone-100"><span className="block w-full rounded-t bg-emerald-600" style={{ height: `${100 * item.photo_count / maximum}%` }} /></span>
        <span className="block border-t border-stone-200 pt-2 text-xs font-medium">{name.slice(0, 3)}</span>
      </Link></li>;
    })}
  </ul>;
}

export function TopSpeciesChart({ data }: { data: InsightsResponse }) {
  return <InsightsPanel title="Top Species" description="Top 10 verified species by photo count. Percentages use all active photos in this period.">
    {data.top_species.length ? <PhotoBars rows={data.top_species.map((item) => ({
      key: String(item.taxon_id), label: item.common_name?.trim() || item.scientific_name,
      detail: item.common_name?.trim() ? item.scientific_name : undefined,
      photoCount: item.photo_count, percentage: item.percentage,
      href: insightsListHref(data.year ?? undefined, { taxon_id: item.taxon_id }),
    }))} /> : <p className="text-sm text-stone-500">No verified species in this period.</p>}
    <div className="mt-5 border-t border-stone-100 pt-4 text-xs leading-6 text-stone-500">
      <p>{count(data.overview.unverified_photos)} photos without linked verified taxonomy.</p>
      <p>{count(data.overview.other_taxon_rank_photos)} photos linked to taxa at other ranks.</p>
      <p>Photos count images, not individual animals or wildlife observations. AI guesses are excluded from this ranking.</p>
    </div>
  </InsightsPanel>;
}

function Distribution({ title, rows, year, kind }: { title: string; rows: InsightsDistribution[]; year?: number; kind: "category" | "status" }) {
  return <InsightsPanel title={title} description="Photo counts and share of active photos in this period.">
    <PhotoBars rows={rows.map((item) => ({
      key: JSON.stringify([item.other, item.value]), label: item.label,
      photoCount: item.photo_count, percentage: item.percentage,
      href: item.other ? undefined : insightsListHref(year, kind === "category" ? (item.value === null ? { uncategorized: true } : { category: item.value }) : { status: item.value as PhotoStatus }),
    }))} />
    {rows.some((item) => item.other) && <p className="mt-4 text-xs text-stone-500">The remaining values are grouped as Other. Browse List to explore them.</p>}
  </InsightsPanel>;
}

export function CategoryBreakdown({ data }: { data: InsightsResponse }) {
  return <Distribution title="Photo categories" rows={data.categories} year={data.year ?? undefined} kind="category" />;
}

export function ClassificationBreakdown({ data }: { data: InsightsResponse }) {
  return <Distribution title="Classification status" rows={data.classification} year={data.year ?? undefined} kind="status" />;
}

export function LocationCoverage({ data }: { data: InsightsResponse }) {
  const gps = data.overview.gps;
  return <InsightsPanel title="Geographic coverage" description="GPS requires a complete latitude/longitude pair within valid ranges.">
    <p className="text-4xl font-semibold tracking-tight text-emerald-950">{percent(gps.percentage)} <span className="text-sm font-normal text-stone-500">GPS coverage</span></p>
    <dl className="mt-5 grid grid-cols-2 gap-4 text-sm"><div><dt className="text-stone-500">With GPS</dt><dd className="mt-1 font-semibold">{count(gps.known)} {gps.known === 1 ? "photo" : "photos"}</dd></div><div><dt className="text-stone-500">Without valid GPS</dt><dd className="mt-1 font-semibold">{count(gps.missing)} {gps.missing === 1 ? "photo" : "photos"}</dd></div></dl>
    <Link href={mapCatalogHref(insightsYearRange(data.year ?? undefined))} className="mt-6 inline-flex min-h-11 items-center rounded-lg bg-emerald-800 px-4 text-sm font-semibold text-white hover:bg-emerald-900 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-700">View on Map</Link>
  </InsightsPanel>;
}
