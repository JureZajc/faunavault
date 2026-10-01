import { ImportSession } from "./api";
import { cullingListHref, DEFAULT_CATALOG_STATE, writeCatalogState } from "./catalog-query";

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
