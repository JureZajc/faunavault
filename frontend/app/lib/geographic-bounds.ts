export const BOUND_KEYS = ["bbox_south", "bbox_north", "bbox_west", "bbox_east"] as const;
export type AreaBounds = Record<typeof BOUND_KEYS[number], number>;
export type BoundsQuery = Partial<AreaBounds>;
export const EMPTY_BOUNDS = { bbox_south: undefined, bbox_north: undefined, bbox_west: undefined, bbox_east: undefined };

export function hasArea(query: BoundsQuery) {
  return BOUND_KEYS.some((key) => query[key] !== undefined);
}

export function boundsError(query: BoundsQuery): string | null {
  if (!hasArea(query)) return null;
  if (BOUND_KEYS.some((key) => query[key] === undefined)) return "Enter all four area coordinates, or clear the area filter.";
  if (BOUND_KEYS.some((key) => !Number.isFinite(query[key]))) return "Area coordinates must be finite numbers. Correct the coordinates or clear the area filter.";
  const { bbox_south: south, bbox_north: north, bbox_west: west, bbox_east: east } = query as AreaBounds;
  if (south < -90 || north > 90 || north < -90 || south > 90) return "Area latitudes must be between -90 and 90.";
  if (west < -180 || west > 180 || east < -180 || east > 180) return "Area longitudes must be between -180 and 180.";
  if (south >= north) return "South latitude must be less than North latitude.";
  if (west === east || (west === 180 && east === -180)) return "The area must have a non-zero longitude width.";
  return null;
}

export function parseCoordinate(value: string): number {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : NaN;
}

export function areaSummary(query: BoundsQuery) {
  if (boundsError(query)) return "Invalid geographic area";
  if (!hasArea(query)) return "No area selected";
  return `${query.bbox_south!.toFixed(5)}° to ${query.bbox_north!.toFixed(5)}° latitude; ${query.bbox_west!.toFixed(5)}° to ${query.bbox_east!.toFixed(5)}° longitude${query.bbox_west! > query.bbox_east! ? " (crosses antimeridian)" : ""}`;
}

// Leaflet uses unwrapped world coordinates. Preserve the drawn interval, even
// across 180°, rather than sorting wrapped endpoints into a different region.
export function boundsFromCorners(first: { lat: number; lng: number }, second: { lat: number; lng: number }): AreaBounds {
  const west = Math.min(first.lng, second.lng);
  const east = Math.max(first.lng, second.lng);
  const wrap = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
  return {
    bbox_south: Math.max(-90, Math.min(first.lat, second.lat)),
    bbox_north: Math.min(90, Math.max(first.lat, second.lat)),
    bbox_west: east - west >= 360 ? -180 : wrap(west),
    bbox_east: east - west >= 360 ? 180 : (wrap(east) === -180 ? 180 : wrap(east)),
  };
}

export function displayAreaBounds(area: AreaBounds): [[number, number], [number, number]] {
  return [[area.bbox_south, area.bbox_west], [area.bbox_north, area.bbox_east + (area.bbox_west > area.bbox_east ? 360 : 0)]];
}
