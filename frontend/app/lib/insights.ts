import { CatalogQuery } from "./api";
import { DEFAULT_CATALOG_STATE, writeCatalogState } from "./catalog-query";

export function parseInsightsYear(value: string | null): number | undefined {
  if (!value || !/^\d{1,4}$/.test(value)) return undefined;
  const year = Number(value);
  return year >= 1 && year <= 9999 ? year : undefined;
}

export function parseComparisonYear(value: string | null, year?: number): number | undefined {
  const comparison = parseInsightsYear(value);
  return year !== undefined && comparison !== year ? comparison : undefined;
}

export function insightsDifference(primary: number, baseline: number, percentagePoints = false) {
  const difference = Math.round((primary - baseline) * 100) / 100;
  const signed = (value: number) => `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(value)}`;
  if (percentagePoints) return `${signed(difference)} percentage points`;
  const change = baseline === 0 ? "N/A — zero baseline" : `${signed(100 * difference / baseline)}%`;
  return `${signed(difference)} (${change})`;
}

export function insightsYearRange(year?: number): Pick<CatalogQuery, "taken_from" | "taken_to"> {
  if (year === undefined) return {};
  const value = String(year).padStart(4, "0");
  return { taken_from: `${value}-01-01`, taken_to: `${value}-12-31` };
}

export function insightsListHref(year?: number, filters: Partial<CatalogQuery> = {}) {
  const params = writeCatalogState(new URLSearchParams(), {
    ...DEFAULT_CATALOG_STATE, ...insightsYearRange(year), ...filters,
  });
  return params.size ? `/?${params}` : "/";
}

export const insightsCount = (value: number) => new Intl.NumberFormat("en").format(value);
export const insightsPercent = (value: number) => `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(value)}%`;
