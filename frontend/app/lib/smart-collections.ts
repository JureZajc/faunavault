import { SmartCollectionQuery } from "./api";
import { CatalogState, DEFAULT_CATALOG_STATE, writeCatalogState } from "./catalog-query";

export function savedQueryFromState(state: CatalogState, searchInput: string): SmartCollectionQuery {
  if (state.event_id !== undefined) throw new Error("Trip/Event membership cannot be saved as Smart Collection criteria. Clear the Trip/Event filter first.");
  return {
    import_session_id: state.import_session_id,
    search: searchInput.trim() || undefined,
    culling_state: state.culling_state,
    favorites_only: state.favorites_only, rating: state.rating, rating_min: state.rating_min, unrated: state.unrated,
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
  if (query.import_session_id) parts.push(`Import Session: ${query.import_session_id}`);
  if (query.culling_state) parts.push(`Culling: ${query.culling_state === "pick" ? "Picked" : query.culling_state === "reject" ? "Rejected" : "Undecided"}`);
  if (query.favorites_only) parts.push("Favorites only");
  if (query.rating) parts.push(`Rating: exactly ${query.rating}`);
  if (query.rating_min) parts.push(`Rating: at least ${query.rating_min}`);
  if (query.unrated) parts.push("Unrated");
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
