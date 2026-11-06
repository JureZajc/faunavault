import { BOUND_KEYS, boundsError, BoundsQuery, parseCoordinate } from "./geographic-bounds";
import { sightingId } from "./sightings";

export type SightingMapFilters = BoundsQuery & {
  date_from?: string;
  date_to?: string;
  taxon_id?: number;
  focus?: number;
};

const filterKeys = ["date_from", "date_to", "taxon_id", ...BOUND_KEYS, "focus"] as const;

export function sightingMapQuery(filters: SightingMapFilters) {
  const params = new URLSearchParams();
  for (const key of filterKeys) {
    const value = filters[key];
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return params.toString();
}

export function sightingMapHref(filters: SightingMapFilters = {}) {
  const query = sightingMapQuery(filters);
  return query ? `/sightings/map?${query}` : "/sightings/map";
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function sightingDateError(from = "", to = "") {
  if ((from && !validDate(from)) || (to && !validDate(to))) return "Enter valid observation dates.";
  if (from && to && from > to) return "From date must be on or before through date.";
  return null;
}

export function readSightingMapQuery(params: URLSearchParams) {
  const taxon = params.get("taxon_id");
  const focus = params.get("focus");
  const filters: SightingMapFilters = {
    date_from: params.get("date_from") ?? undefined,
    date_to: params.get("date_to") ?? undefined,
    taxon_id: sightingId(taxon) ?? undefined,
    focus: sightingId(focus) ?? undefined,
  };
  for (const key of BOUND_KEYS) {
    const value = params.get(key);
    if (value !== null) filters[key] = parseCoordinate(value);
  }
  const areaError = boundsError(filters);
  const error = sightingDateError(filters.date_from, filters.date_to)
    ?? (taxon !== null && !filters.taxon_id ? "Choose a valid local species." : null)
    ?? (focus !== null && !filters.focus ? "Invalid focused Sighting ID." : null)
    ?? areaError;
  return { filters, error, areaError };
}
