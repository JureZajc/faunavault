import { SmartCollectionQuery } from "./api";
import { CatalogState, DEFAULT_CATALOG_STATE, writeCatalogState } from "./catalog-query";

export function savedQueryFromState(state: CatalogState, searchInput: string): SmartCollectionQuery {
  return {
    search: searchInput.trim() || undefined,
    status: state.status,
    category: state.uncategorized ? undefined : state.category,
    uncategorized: state.uncategorized ?? false,
    taxon_id: state.taxon_id,
    taken_from: state.taken_from,
    taken_to: state.taken_to,
    sort: state.sort,
    order: state.order,
  };
}

export function smartCollectionEditHref(id: number, query: SmartCollectionQuery | null) {
  const state: CatalogState = { ...DEFAULT_CATALOG_STATE, ...query, page: 1, layout: "flat" };
  const params = writeCatalogState(new URLSearchParams(), state);
  params.set("smart_edit", String(id));
  return `/?${params}`;
}

export function smartCollectionCriteria(query: SmartCollectionQuery): string {
  const parts: string[] = [];
  if (query.search) parts.push(`Search: ${query.search}`);
  if (query.status) parts.push(`Status: ${query.status.replaceAll("_", " ")}`);
  if (query.category) parts.push(`Category: ${query.category}`);
  if (query.uncategorized) parts.push("Uncategorized");
  if (query.taxon_id) parts.push(`Verified taxon #${query.taxon_id}`);
  if (query.taken_from || query.taken_to) parts.push(`Taken: ${query.taken_from ?? "any"} to ${query.taken_to ?? "any"}`);
  parts.push(`Sort: ${query.sort.replaceAll("_", " ")} ${query.order}`);
  return parts.length === 1 && query.sort === "created_at" && query.order === "desc"
    ? "All active photos · newest added first"
    : parts.join(" · ");
}
