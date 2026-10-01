import { ArchiveEventSummary } from "./api";
import { cullingListHref, DEFAULT_CATALOG_STATE, mapCatalogHref, writeCatalogState } from "./catalog-query";

export function eventKindLabel(kind: "trip" | "event") { return kind === "trip" ? "Trip" : "Event"; }
export function eventDateLabel(item: Pick<ArchiveEventSummary, "start_date" | "end_date">) {
  const format = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return item.start_date === item.end_date ? format(item.start_date) : `${format(item.start_date)} – ${format(item.end_date)}`;
}
export function eventListHref(id: number) { return `/?${writeCatalogState(new URLSearchParams(), { ...DEFAULT_CATALOG_STATE, event_id: id })}`; }
export function eventMapHref(id: number) { return mapCatalogHref({ event_id: id }); }
export function eventCullHref(id: number) { return cullingListHref({ ...DEFAULT_CATALOG_STATE, event_id: id }, "", eventListHref(id)); }
export function eventDateHref(item: ArchiveEventSummary) { return `/?${writeCatalogState(new URLSearchParams(), { ...DEFAULT_CATALOG_STATE, taken_from: item.start_date, taken_to: item.end_date })}`; }
export function eventAddHref(item: ArchiveEventSummary, suggested = false) {
  const params = writeCatalogState(new URLSearchParams({ add_to_event: String(item.id) }), { ...DEFAULT_CATALOG_STATE, ...(suggested ? { taken_from: item.start_date, taken_to: item.end_date } : {}) });
  return `/?${params}`;
}
export function eventId(value: string | null) { return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null; }
