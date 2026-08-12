import {
  CatalogOrder,
  CatalogQuery,
  CatalogSort,
  PhotoStatus,
} from "./api";

export type CatalogLayout = "flat" | "grouped";
export type CatalogSortOption =
  | "newest"
  | "oldest"
  | "confidence_desc"
  | "confidence_asc"
  | "name_asc"
  | "name_desc"
  | "species_asc"
  | "species_desc"
  | "needs_review_first"
  | "pending_first";

export type CatalogState = CatalogQuery & { layout: CatalogLayout };

export const DEFAULT_CATALOG_STATE: CatalogState = {
  page: 1,
  page_size: 48,
  sort: "created_at",
  order: "desc",
  layout: "flat",
};

const statuses = new Set<PhotoStatus>([
  "pending",
  "classified",
  "needs_review",
]);
const sorts = new Set<CatalogSort>([
  "created_at",
  "name",
  "species",
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

export function parseCatalogState(params: URLSearchParams): CatalogState {
  const status = params.get("catalog_status");
  const sort = params.get("catalog_sort");
  const order = params.get("catalog_order");
  const search = params.get("catalog_search")?.trim() || undefined;
  const uncategorized = params.get("catalog_uncategorized") === "1";
  const category = uncategorized
    ? undefined
    : params.get("catalog_category")?.trim() || undefined;
  return {
    page: positiveInteger(params.get("catalog_page")) ?? 1,
    page_size: 48,
    search,
    status: status && statuses.has(status as PhotoStatus) ? (status as PhotoStatus) : undefined,
    category,
    uncategorized: uncategorized || undefined,
    taxon_id: positiveInteger(params.get("catalog_taxon")),
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
  setOrDelete("catalog_page", state.page > 1 ? String(state.page) : undefined);
  setOrDelete("catalog_search", state.search);
  setOrDelete("catalog_status", state.status);
  setOrDelete("catalog_category", state.category);
  setOrDelete("catalog_uncategorized", state.uncategorized ? "1" : undefined);
  setOrDelete("catalog_taxon", state.taxon_id ? String(state.taxon_id) : undefined);
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
