import type { SmartCollectionQuery, SmartCollectionQueryRead } from "./api";
import { areaSummary, boundsError } from "./geographic-bounds";
import { CatalogState, DEFAULT_CATALOG_STATE, equipmentQuery, metadataIssueLabels, writeCatalogState } from "./catalog-query";

import { hasShootingRanges } from "./shooting-settings";

export const SMART_COLLECTION_QUERY_VERSION = 2;

export function smartCollectionSaveError(state: CatalogState) {
  if (hasShootingRanges(state)) return "Clear Shooting Settings filters before saving Smart Collection criteria.";
  if (state.event_id !== undefined) return "Trip/Event membership cannot be saved as Smart Collection criteria. Clear the Trip/Event filter first.";
  return boundsError(state);
}

export function savedQueryFromState(state: CatalogState, searchInput: string): SmartCollectionQuery {
  const error = smartCollectionSaveError(state);
  if (error) throw new Error(error);
  return {
    tags: state.tags,
    untagged: state.untagged,
    ...equipmentQuery(state),
    metadata_issue: state.metadata_issue,
    bbox_south: state.bbox_south,
    bbox_north: state.bbox_north,
    bbox_west: state.bbox_west,
    bbox_east: state.bbox_east,
    import_session_id: state.import_session_id,
    search: searchInput.trim() || undefined,
    culling_state: state.culling_state,
    favorites_only: state.favorites_only, rating: state.rating, rating_min: state.rating_min, unrated: state.unrated,
    status: state.status,
    category: state.category,
    uncategorized: state.uncategorized ?? false,
    taxon_id: state.taxon_id,
    taken_from: state.taken_from,
    taken_to: state.taken_to,
    sort: state.sort,
    order: state.order,
  };
}

export function smartCollectionEditHref(id: number, query: SmartCollectionQueryRead | null) {
  // The API returns null for unset criteria. Keep empty equipment strings and zero coordinates.
  const criteria = Object.fromEntries(Object.entries(query ?? {}).filter(([, value]) => value != null));
  const state: CatalogState = { ...DEFAULT_CATALOG_STATE, ...criteria };
  const params = writeCatalogState(new URLSearchParams(), state);
  params.set("smart_edit", String(id));
  return `/?${params}`;
}

export function smartCollectionCriteria(query: SmartCollectionQueryRead): string {
  const parts: string[] = [];
  if (query.tags?.length) parts.push(`Tags (all): ${query.tags.map((tag) => JSON.stringify(tag)).join(", ")}`);
  if (query.untagged) parts.push("Photos without tags");
  if (query.camera_make != null) parts.push(`Camera make: ${query.camera_make || "Missing"}`);
  if (query.camera_model != null) parts.push(`Camera model: ${query.camera_model || "Missing"}`);
  if (query.unknown_camera) parts.push("Unknown camera");
  if (query.lens_model != null) parts.push(`Lens: ${query.lens_model || "Missing model"}`);
  if (query.unknown_lens) parts.push("Unknown lens");
  if (query.metadata_issue) parts.push(`Metadata: ${metadataIssueLabels[query.metadata_issue]}`);
  if (query.bbox_south != null) parts.push(`Area: ${areaSummary({
    bbox_south: query.bbox_south, bbox_north: query.bbox_north ?? undefined,
    bbox_west: query.bbox_west ?? undefined, bbox_east: query.bbox_east ?? undefined,
  })}`);
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
