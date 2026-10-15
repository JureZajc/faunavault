import { ImportSession } from "./api";
import { cullingListHref, DEFAULT_CATALOG_STATE, parseCatalogState, writeCatalogState } from "./catalog-query";

export function importEventAddHref(id: string, eventId: number, current = new URLSearchParams()) {
  const params = writeCatalogState(new URLSearchParams(), { ...parseCatalogState(current), page: 1, event_id: undefined, import_session_id: id });
  params.set("add_to_event", String(eventId));
  return `/?${params}`;
}

export function importSuggestedTitle(item: ImportSession) {
  const label = item.label?.trim();
  // Labels are normally safe basenames; also defend against older/private data.
  return label && !/[\\/:\p{Cc}\p{Cf}]/u.test(label) && !label.startsWith("~") && !label.includes("..") ? label.slice(0, 100) : "";
}

export function importListHref(id: string) {
  return `/?${writeCatalogState(new URLSearchParams(), { ...DEFAULT_CATALOG_STATE, import_session_id: id })}`;
}

export function importCullHref(id: string) {
  return cullingListHref({ ...DEFAULT_CATALOG_STATE, import_session_id: id }, "", importListHref(id));
}

export function importRejectedHref(id: string) {
  return `/?${writeCatalogState(new URLSearchParams(), { ...DEFAULT_CATALOG_STATE, import_session_id: id, culling_state: "reject" })}`;
}

export function importSourceLabel(item: ImportSession) {
  return item.source_kind === "browser_upload" ? "Browser upload" : item.source_kind === "folder_import" ? "Folder import" : item.source_kind.replaceAll("_", " ");
}

export function importDate(value: string) {
  // SQLite stores UTC without a suffix; never interpret archive time as local.
  return new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`).toLocaleString();
}
