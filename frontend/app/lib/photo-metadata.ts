export function parseTags(value: string) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const tag = item.trim();
    if (tag && !seen.has(tag)) {
      normalized.push(tag);
      seen.add(tag);
    }
  }
  return normalized;
}

function cameraLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function formatCameraLocalDate(value: string, includeTime = false) {
  const parsed = cameraLocalDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
    timeZone: "UTC",
  }).format(parsed);
}

export function formatUtcOffset(minutes: number) {
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
