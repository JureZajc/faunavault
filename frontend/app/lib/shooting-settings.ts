export const SHOOTING_RANGES = [
  { field: "iso_speed", label: "ISO" },
  { field: "aperture_f_number", label: "Aperture (f-number)" },
  { field: "focal_length_mm", label: "Focal length (mm)" },
  { field: "exposure_time_seconds", label: "Exposure time (seconds)" },
] as const;

type RangeKey = `${typeof SHOOTING_RANGES[number]["field"]}_${"min" | "max"}`;
export type ShootingRangeQuery = Partial<Record<RangeKey, number>>;
export const SHOOTING_RANGE_KEYS = SHOOTING_RANGES.flatMap(({ field }) =>
  [`${field}_min`, `${field}_max`] as const,
);
export const EMPTY_SHOOTING_RANGES: ShootingRangeQuery = Object.fromEntries(
  SHOOTING_RANGE_KEYS.map((key) => [key, undefined]),
);

export function hasShootingRanges(query: ShootingRangeQuery) {
  return SHOOTING_RANGE_KEYS.some((key) => query[key] !== undefined);
}

export function parseShootingRangeValue(key: RangeKey, input: string) {
  const text = input.trim();
  const isISO = key.startsWith("iso_speed_");
  const pattern = isISO ? /^\d+$/ : /^\+?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i;
  const value = Number(text.replace(",", "."));
  return pattern.test(text) && Number.isFinite(value) && value > 0 &&
    (!isISO || Number.isSafeInteger(value)) ? value : NaN;
}

export function validateShootingRanges(input: Partial<Record<RangeKey, string>>) {
  const ranges: ShootingRangeQuery = {};
  for (const { field, label } of SHOOTING_RANGES) {
    const minKey = `${field}_min` as const;
    const maxKey = `${field}_max` as const;
    for (const key of [minKey, maxKey]) {
      const text = input[key]?.trim();
      if (!text) continue;
      const value = parseShootingRangeValue(key, text);
      if (Number.isNaN(value)) {
        return { error: `${key === minKey ? "Minimum" : "Maximum"} ${label} must be a positive ${field === "iso_speed" ? "whole number" : "number"}.`, invalid: key };
      }
      ranges[key] = value;
    }
    const minimum = ranges[minKey];
    const maximum = ranges[maxKey];
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      return { error: `Minimum ${label} must be less than or equal to maximum.`, invalid: minKey };
    }
  }
  return { ranges };
}

export function formatShootingNumber(value: number, locale?: string) {
  return new Intl.NumberFormat(locale, {
    useGrouping: false,
    maximumSignificantDigits: 17,
    notation: value < 0.000001 || value >= 1e12 ? "scientific" : "standard",
  }).format(value);
}

export function formatShutterSpeed(seconds: number, locale?: string) {
  const denominator = Math.round(1 / seconds);
  if (seconds < 1 && Number.isSafeInteger(denominator) && 1 / denominator === seconds) {
    return `1/${denominator.toLocaleString(locale, { useGrouping: false })} s`;
  }
  return `${formatShootingNumber(seconds, locale)} s`;
}
