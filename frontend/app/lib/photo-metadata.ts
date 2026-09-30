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
  // Date.UTC interprets years 0–99 as 1900–1999.
  parsed.setUTCFullYear(Number(year));
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

export function editableUtcOffset(minutes: number | null) {
  return minutes === null ? "" : formatUtcOffset(minutes).replace("UTC", "").replace("−", "-");
}

export function parseCaptureFields(date: string, offset: string) {
  const timestamp = date.trim();
  const offsetText = offset.trim();
  if (!timestamp) {
    if (offsetText) throw new Error("A UTC offset requires a capture date/time.");
    return { captured_at: null, captured_at_offset_minutes: null };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?$/.exec(timestamp);
  if (!match) throw new Error("Enter a valid camera-local capture date/time.");
  const [, y, m, d, h, min, s = "00", fraction = ""] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(h) > 23 || Number(min) > 59 || Number(s) > 59) {
    throw new Error("Enter a valid camera-local capture date/time.");
  }
  let minutes: number | null = null;
  if (offsetText) {
    const parsed = /^([+-])(\d{2}):(\d{2})$/.exec(offsetText);
    if (!parsed || Number(parsed[2]) > 23 || Number(parsed[3]) > 59) {
      throw new Error("UTC offset must be empty or signed HH:MM, from -23:59 to +23:59.");
    }
    minutes = (parsed[1] === "-" ? -1 : 1) * (Number(parsed[2]) * 60 + Number(parsed[3]));
  }
  return { captured_at: `${y}-${m}-${d}T${h}:${min}:${s}${fraction}`, captured_at_offset_minutes: minutes };
}

export function parseLocationFields(latitude: string, longitude: string) {
  const lat = latitude.trim(), lon = longitude.trim();
  if (!lat && !lon) return { latitude: null, longitude: null };
  if (!lat || !lon) throw new Error("Enter both latitude and longitude, or remove both.");
  const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const latitudeNumber = Number(lat), longitudeNumber = Number(lon);
  if (!numberPattern.test(lat) || !Number.isFinite(latitudeNumber) || latitudeNumber < -90 || latitudeNumber > 90) {
    throw new Error("Latitude must be a finite number from -90 to 90.");
  }
  if (!numberPattern.test(lon) || !Number.isFinite(longitudeNumber) || longitudeNumber < -180 || longitudeNumber > 180) {
    throw new Error("Longitude must be a finite number from -180 to 180.");
  }
  return { latitude: latitudeNumber, longitude: longitudeNumber };
}
