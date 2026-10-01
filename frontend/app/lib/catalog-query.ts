import {
  CatalogOrder,
  CatalogQuery,
  CatalogSort,
  PhotoStatus,
  PhotoRating,
  CullingFilter,
} from "./api";

export type CatalogLayout = "flat" | "grouped";
export type HomeView = "list" | "album" | "trash";
export type CatalogSortOption =
  | "newest"
  | "oldest"
  | "taken_newest"
  | "taken_oldest"
  | "rating_desc"
  | "rating_asc"
  | "confidence_desc"
  | "confidence_asc"
  | "name_asc"
  | "name_desc"
  | "species_asc"
  | "species_desc"
  | "needs_review_first"
  | "pending_first";

export type CatalogState = CatalogQuery & { layout: CatalogLayout };
export type MapCatalogQuery = Pick<CatalogQuery,
  "status" | "category" | "uncategorized" | "taxon_id" | "taken_from" | "taken_to"
>;

export function mapCatalogQuery(state: MapCatalogQuery): MapCatalogQuery {
  const { status, category, uncategorized, taxon_id, taken_from, taken_to } = state;
  return { status, category, uncategorized, taxon_id, taken_from, taken_to };
}

export function writeMapCatalogState(current: URLSearchParams, state: MapCatalogQuery) {
  const params = new URLSearchParams(current);
  for (const key of Array.from(params.keys())) {
    if (key.startsWith("catalog_") || key === "view" || key === "smart_edit") params.delete(key);
  }
  return writeCatalogState(params, { ...DEFAULT_CATALOG_STATE, ...mapCatalogQuery(state) });
}

export function mapCatalogHref(state: MapCatalogQuery) {
  const query = writeMapCatalogState(new URLSearchParams(), state).toString();
  return query ? `/map?${query}` : "/map";
}

export function mapListHref(state: CatalogState) {
  const query = writeCatalogState(new URLSearchParams(), {
    ...DEFAULT_CATALOG_STATE, ...mapCatalogQuery(state), search: state.search,
    favorites_only: state.favorites_only, rating: state.rating, rating_min: state.rating_min, unrated: state.unrated,
    culling_state: state.culling_state,
    import_session_id: state.import_session_id,
  }).toString();
  return query ? `/?${query}` : "/";
}

export const DEFAULT_CATALOG_STATE: CatalogState = {
  page: 1,
  page_size: 48,
  sort: "created_at",
  order: "desc",
  layout: "flat",
};

export const REJECTED_PHOTOS_HREF = "/?catalog_culling_state=reject";

export function hasAdditionalRejectedFilters(state: CatalogQuery) {
  return Boolean(
    state.import_session_id || state.search || state.status || state.category || state.uncategorized ||
    state.taxon_id || state.taken_from || state.taken_to || state.favorites_only ||
    state.rating || state.rating_min || state.unrated,
  );
}

const statuses = new Set<PhotoStatus>([
  "pending",
  "classified",
  "needs_review",
]);
const sorts = new Set<CatalogSort>([
  "created_at",
  "captured_at",
  "name",
  "species",
  "rating",
  "confidence",
  "needs_review",
  "pending",
]);
const orders = new Set<CatalogOrder>(["asc", "desc"]);

const sortOptionMap: Record<
  CatalogSortOption,
  Pick<CatalogState, "sort" | "order">
> = {
  newest: { sort: "created_at", order: "desc" },
  oldest: { sort: "created_at", order: "asc" },
  taken_newest: { sort: "captured_at", order: "desc" },
  taken_oldest: { sort: "captured_at", order: "asc" },
  rating_desc: { sort: "rating", order: "desc" },
  rating_asc: { sort: "rating", order: "asc" },
  confidence_desc: { sort: "confidence", order: "desc" },
  confidence_asc: { sort: "confidence", order: "asc" },
  name_asc: { sort: "name", order: "asc" },
  name_desc: { sort: "name", order: "desc" },
  species_asc: { sort: "species", order: "asc" },
  species_desc: { sort: "species", order: "desc" },
  needs_review_first: { sort: "needs_review", order: "desc" },
  pending_first: { sort: "pending", order: "desc" },
};

function positiveInteger(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseRating(value: string | null): PhotoRating | undefined {
  return value && /^[1-5]$/.test(value) ? Number(value) as PhotoRating : undefined;
}

export function hasCurationFilters(state: Pick<CatalogQuery, "favorites_only" | "rating" | "rating_min" | "unrated" | "culling_state">) {
  return Boolean(state.culling_state || state.favorites_only || state.rating || state.rating_min || state.unrated);
}

function isoDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

export function parseCatalogState(params: URLSearchParams): CatalogState {
  const status = params.get("catalog_status");
  const sort = params.get("catalog_sort");
  const order = params.get("catalog_order");
  const search = params.get("catalog_search")?.trim() || undefined;
  const uncategorized = params.get("catalog_uncategorized") === "1";
  const category = uncategorized
    ? undefined
    : params.get("catalog_category")?.trim() || undefined;
  const rating = parseRating(params.get("catalog_rating"));
  const ratingMin = parseRating(params.get("catalog_rating_min"));
  const unrated = params.get("catalog_unrated") === "1";
  const culling = params.get("catalog_culling_state");
  return {
    import_session_id: params.get("catalog_import_session_id") || undefined,
    culling_state: culling && ["pick", "reject", "undecided"].includes(culling) ? culling as CullingFilter : undefined,
    favorites_only: params.get("catalog_favorites_only") === "1" || undefined,
    rating,
    rating_min: ratingMin,
    unrated: unrated || undefined,
    page: positiveInteger(params.get("catalog_page")) ?? 1,
    page_size: 48,
    search,
    status: status && statuses.has(status as PhotoStatus) ? (status as PhotoStatus) : undefined,
    category,
    uncategorized: uncategorized || undefined,
    taxon_id: positiveInteger(params.get("catalog_taxon")),
    taken_from: isoDate(params.get("catalog_taken_from")),
    taken_to: isoDate(params.get("catalog_taken_to")),
    sort: sort && sorts.has(sort as CatalogSort) ? (sort as CatalogSort) : "created_at",
    order: order && orders.has(order as CatalogOrder) ? (order as CatalogOrder) : "desc",
    layout: params.get("catalog_layout") === "grouped" ? "grouped" : "flat",
  };
}

export function writeCatalogState(
  current: URLSearchParams,
  state: CatalogState,
) {
  const params = new URLSearchParams(current.toString());
  const setOrDelete = (key: string, value?: string) => {
    if (value) params.set(key, value);
    else params.delete(key);
  };
  setOrDelete("catalog_import_session_id", state.import_session_id);
  setOrDelete("catalog_favorites_only", state.favorites_only ? "1" : undefined);
  setOrDelete("catalog_rating", state.rating ? String(state.rating) : undefined);
  setOrDelete("catalog_rating_min", state.rating_min ? String(state.rating_min) : undefined);
  setOrDelete("catalog_unrated", state.unrated ? "1" : undefined);
  setOrDelete("catalog_culling_state", state.culling_state);
  setOrDelete("catalog_page", state.page > 1 ? String(state.page) : undefined);
  setOrDelete("catalog_search", state.search);
  setOrDelete("catalog_status", state.status);
  setOrDelete("catalog_category", state.category);
  setOrDelete("catalog_uncategorized", state.uncategorized ? "1" : undefined);
  setOrDelete("catalog_taxon", state.taxon_id ? String(state.taxon_id) : undefined);
  setOrDelete("catalog_taken_from", state.taken_from);
  setOrDelete("catalog_taken_to", state.taken_to);
  setOrDelete(
    "catalog_sort",
    state.sort !== "created_at" ? state.sort : undefined,
  );
  setOrDelete(
    "catalog_order",
    state.order !== "desc" ? state.order : undefined,
  );
  setOrDelete("catalog_layout", state.layout === "grouped" ? "grouped" : undefined);
  return params;
}

export function cullingListHref(state: CatalogState, searchInput: string, returnTo: string) {
  const params = writeCatalogState(new URLSearchParams(), {
    ...state, search: searchInput.trim() || undefined, page: 1, layout: "flat",
  });
  params.set("source", "list");
  params.set("returnTo", returnTo);
  return `/cull?${params}`;
}

export function parseHomeView(params: URLSearchParams): HomeView {
  const view = params.get("view");
  return view === "album" || view === "trash" ? view : "list";
}

export function writeHomeView(
  current: URLSearchParams,
  view: HomeView,
) {
  const params = new URLSearchParams(current.toString());
  if (view === "list") params.delete("view");
  else params.set("view", view);
  return params;
}

export function catalogSortOption(state: CatalogState): CatalogSortOption {
  const match = Object.entries(sortOptionMap).find(
    ([, value]) => value.sort === state.sort && value.order === state.order,
  );
  return (match?.[0] as CatalogSortOption | undefined) ?? "newest";
}

export function applyCatalogSortOption(
  state: CatalogState,
  option: CatalogSortOption,
): CatalogState {
  return { ...state, ...sortOptionMap[option], page: 1 };
}
