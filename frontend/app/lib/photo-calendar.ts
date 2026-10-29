import { CalendarDay } from "./api";
import { catalogListHref, DEFAULT_CATALOG_STATE } from "./catalog-query";
import { timelineMonthRange } from "./photo-timeline";

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
});

export function calendarMonth(year: number, month: number) {
  const { takenFrom, takenTo } = timelineMonthRange(year, month);
  const first = new Date(0);
  first.setUTCFullYear(year, month - 1, 1);
  const offset = (first.getUTCDay() + 6) % 7;
  return {
    offset,
    days: Array.from({ length: Number(takenTo.slice(-2)) }, (_, index) => `${takenFrom.slice(0, 8)}${String(index + 1).padStart(2, "0")}`),
  };
}

export function calendarDayHref(date: string) {
  return catalogListHref({ ...DEFAULT_CATALOG_STATE, taken_from: date, taken_to: date, sort: "captured_at", order: "desc" });
}

export function calendarDayLabel(date: string, count: number) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  return `${dayFormatter.format(value)}: ${count} ${count === 1 ? "photo" : "photos"}`;
}

// A one-photo day stays Low even in a sparse year. Larger years scale to their
// own maximum; levels describe photo volume, never wildlife sightings.
export function calendarThresholds(maximum: number) {
  const low = Math.max(1, Math.ceil(maximum / 3));
  return { low, medium: Math.max(low + 1, Math.ceil(2 * maximum / 3)) };
}

export function calendarIntensity(count: number, maximum: number) {
  const { low, medium } = calendarThresholds(maximum);
  return count === 0 ? 0 : count <= low ? 1 : count <= medium ? 2 : 3;
}

export function mostActiveDay(days: CalendarDay[]) {
  return days.reduce<CalendarDay | null>((best, day) => !best || day.photo_count > best.photo_count || (day.photo_count === best.photo_count && day.date < best.date) ? day : best, null);
}
