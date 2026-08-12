export type PhotoStatus = "pending" | "classified" | "needs_review";

export type Photo = {
  id: number;
  original_filename: string;
  stored_filename: string;
  resized_filename: string;
  thumbnail_filename: string;
  display_title: string | null;
  common_name: string | null;
  breed_guess: string | null;
  species_guess: string | null;
  category: string | null;
  confidence: number | null;
  description: string | null;
  tags: string[];
  status: PhotoStatus;
  animal_id: number | null;
  content_sha256: string | null;
  original_size_bytes: number | null;
  media_type: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaxonCandidate = {
  provider: "gbif";
  external_taxon_id: number;
  scientific_name: string;
  canonical_name: string;
  common_name: string | null;
  rank: string;
  kingdom: string | null;
  phylum: string | null;
  class: string | null;
  order: string | null;
  family: string | null;
  genus: string | null;
  species: string | null;
  cached: boolean;
};

export type TaxonomySearchResponse = {
  results: TaxonCandidate[];
  external_available: boolean;
  warning: string | null;
};

export type FilterOption = { value: string; count: number };
export type TaxonomyFilters = {
  classes: FilterOption[];
  orders: FilterOption[];
  families: FilterOption[];
  genera: FilterOption[];
  species: FilterOption[];
};

export type AlbumSummary = {
  album_key: string;
  verified: boolean;
  common_name: string | null;
  scientific_name: string;
  rank: string | null;
  class: string | null;
  order: string | null;
  family: string | null;
  genus: string | null;
  species: string | null;
  animal_count: number;
  photo_count: number;
  newest_at: string | null;
  cover_photo_id: number | null;
  cover_thumbnail_filename: string | null;
};

export type Paginated<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
};

export type CatalogSort =
  | "created_at"
  | "name"
  | "species"
  | "confidence"
  | "needs_review"
  | "pending";

export type CatalogOrder = "asc" | "desc";

export type CatalogQuery = {
  page: number;
  page_size: number;
  search?: string;
  status?: PhotoStatus;
  category?: string;
  uncategorized?: boolean;
  taxon_id?: number;
  sort: CatalogSort;
  order: CatalogOrder;
};

export type CatalogFacets = {
  active_total: number;
  status_counts: Record<PhotoStatus, number>;
  categories: { value: string; count: number }[];
  uncategorized_count: number;
};

export type CatalogPhotoPage = Paginated<Photo> & {
  total_pages: number;
  facets: CatalogFacets;
};

export type CatalogTaxonOption = {
  taxon_id: number;
  label: string;
  scientific_name: string;
  count: number;
};

export type CatalogTaxonPage = Paginated<CatalogTaxonOption> & {
  total_pages: number;
  selected: CatalogTaxonOption | null;
};

export type Animal = {
  id: number;
  identifier: string;
  display_name: string | null;
  taxon_id: number | null;
  legacy_common_name: string | null;
  legacy_species_name: string | null;
  taxonomy_status: string;
  taxonomy_note: string | null;
  created_at: string;
  updated_at: string;
};

export type AlbumDetail = AlbumSummary & {
  taxonomy: TaxonCandidate | null;
  animals: Paginated<Animal>;
  photos: Paginated<Photo>;
};

export type AlbumTaxonSelectionResponse = {
  album_key: string;
  updated_animals: number;
  taxon: TaxonCandidate;
};

export type PhotoUpdate = Partial<{
  display_title: string | null;
  common_name: string | null;
  breed_guess: string | null;
  species_guess: string | null;
  category: string | null;
  confidence: number | null;
  description: string | null;
  tags: string[];
  status: PhotoStatus;
}>;

export type BatchUploadFailure = {
  file_index: number;
  filename: string;
  error: string;
  code: string | null;
  photo_id: number | null;
  location: "catalog" | "trash" | null;
};

export type VisualDuplicateCandidate = {
  photo_id: number;
  original_filename: string;
  display_title: string | null;
  common_name: string | null;
  species_guess: string | null;
  location: "catalog" | "trash";
  hamming_distance: number;
};

export type PossibleVisualDuplicate = {
  file_index: number;
  filename: string;
  message: string;
  candidates: VisualDuplicateCandidate[];
};

export type BatchUploadResponse = {
  uploaded: Photo[];
  possible_duplicates: PossibleVisualDuplicate[];
  failed: BatchUploadFailure[];
};

export type ClassificationJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type ClassificationJob = {
  id: number;
  photo_id: number;
  status: ClassificationJobStatus;
  batch_id: string;
  batch_kind: "single" | "pending_batch" | "reclassification";
  requested_model: string;
  fallback_model: string | null;
  actual_model: string | null;
  fallback_attempted: boolean;
  prompt_version: string;
  attempt_count: number;
  created_at: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  failure_code: string | null;
  failure_message: string | null;
  classification_status: "classified" | "needs_review" | null;
  photo_original_filename: string | null;
  retryable: boolean;
};

export type ClassificationJobSummary = {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
};

export type ClassificationEnqueueResponse = {
  jobs: { job: ClassificationJob; created: boolean }[];
  rejected: { photo_id: number; code: string; message: string }[];
  summary: ClassificationJobSummary;
};

export type ClassificationJobCollection = {
  jobs: ClassificationJob[];
  summary: ClassificationJobSummary;
};

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type ApiErrorDetails = {
  code?: string;
  message?: string;
  photo_id?: number;
  location?: "catalog" | "trash";
  candidates?: VisualDuplicateCandidate[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function formatErrorDetail(detail: unknown) {
  if (typeof detail === "string") {
    return detail;
  }

  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === "object" && item !== null && "msg" in item
          ? String(item.msg)
          : JSON.stringify(item),
      )
      .join("; ");
  }

  if (detail) {
    return JSON.stringify(detail);
  }

  return "Request failed";
}

function parseVisualDuplicateCandidate(
  value: unknown,
): VisualDuplicateCandidate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.photo_id !== "number" ||
    typeof candidate.original_filename !== "string" ||
    (candidate.location !== "catalog" && candidate.location !== "trash") ||
    typeof candidate.hamming_distance !== "number"
  ) {
    return null;
  }
  return {
    photo_id: candidate.photo_id,
    original_filename: candidate.original_filename,
    display_title:
      typeof candidate.display_title === "string"
        ? candidate.display_title
        : null,
    common_name:
      typeof candidate.common_name === "string" ? candidate.common_name : null,
    species_guess:
      typeof candidate.species_guess === "string"
        ? candidate.species_guess
        : null,
    location: candidate.location,
    hamming_distance: candidate.hamming_distance,
  };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const safeDetails: ApiErrorDetails =
      typeof detail === "object" && detail !== null && !Array.isArray(detail)
        ? {
            code: typeof detail.code === "string" ? detail.code : undefined,
            message:
              typeof detail.message === "string" ? detail.message : undefined,
            photo_id:
              typeof detail.photo_id === "number" ? detail.photo_id : undefined,
            location:
              detail.location === "catalog" || detail.location === "trash"
                ? detail.location
                : undefined,
            candidates: Array.isArray(detail.candidates)
              ? (detail.candidates as unknown[])
                  .map((candidate: unknown) =>
                    parseVisualDuplicateCandidate(candidate),
                  )
                  .filter(
                    (candidate): candidate is VisualDuplicateCandidate =>
                      candidate !== null,
                  )
              : undefined,
          }
        : {};
    throw new ApiError(
      safeDetails.message ?? formatErrorDetail(detail),
      response.status,
      safeDetails,
    );
  }

  return response.json() as Promise<T>;
}

export function imageUrl(
  type: "original" | "resized" | "thumbs",
  filename: string,
) {
  return `${API_BASE_URL}/images/${type}/${encodeURIComponent(filename)}`;
}

export function photoThumbnailUrl(photoId: number) {
  return `${API_BASE_URL}/photos/${photoId}/thumbnail`;
}

export function getTaxonomyFilters() {
  return request<TaxonomyFilters>("/taxonomy/filters");
}

export function getSpeciesAlbums(params: URLSearchParams) {
  return request<Paginated<AlbumSummary>>(`/species-albums?${params}`);
}

export function getSpeciesAlbum(
  albumKey: string,
  params = new URLSearchParams(),
) {
  return request<AlbumDetail>(
    `/species-albums/${encodeURIComponent(albumKey)}?${params}`,
  );
}

export function searchTaxonomy(query: string) {
  return request<TaxonomySearchResponse>(
    `/taxonomy/search?q=${encodeURIComponent(query)}`,
  );
}

export function selectAlbumTaxon(albumKey: string, gbifKey: number) {
  return request<AlbumTaxonSelectionResponse>(
    `/species-albums/${encodeURIComponent(albumKey)}/taxon`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gbif_key: gbifKey }),
    },
  );
}

export function selectAnimalTaxon(animalId: number, gbifKey: number) {
  return request(`/animals/${animalId}/taxon`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gbif_key: gbifKey }),
  });
}

export function getAnimal(animalId: number) {
  return request<Animal>(`/animals/${animalId}`);
}

export function updateAnimalDisplayName(
  animalId: number,
  displayName: string | null,
) {
  return request<Animal>(`/animals/${animalId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: displayName }),
  });
}

export function reconcileTaxonomy() {
  return request<{
    processed: number;
    linked: number;
    ambiguous: number;
    unmatched: number;
    failed: number;
  }>("/taxonomy/reconcile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 50 }),
  });
}

export function getPhotos() {
  return request<Photo[]>("/photos");
}

export function getCatalogPhotos(query: CatalogQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  params.set("page", String(query.page));
  params.set("page_size", String(query.page_size));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.category) params.set("category", query.category);
  if (query.uncategorized) params.set("uncategorized", "true");
  if (query.taxon_id) params.set("taxon_id", String(query.taxon_id));
  params.set("sort", query.sort);
  params.set("order", query.order);
  return request<CatalogPhotoPage>(`/catalog/photos?${params}`, { signal });
}

export function getCatalogTaxa(
  page = 1,
  pageSize = 50,
  includeId?: number,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  if (includeId) params.set("include_id", String(includeId));
  return request<CatalogTaxonPage>(`/catalog/taxa?${params}`, { signal });
}

export function getPhoto(id: string) {
  return request<Photo>(`/photos/${id}`);
}

export function deletePhoto(id: number) {
  return request<{ status: "trashed"; photo_id: number }>(`/photos/${id}`, {
    method: "DELETE",
  });
}

export function getTrashPhotos(page = 1, pageSize = 24) {
  return request<Paginated<Photo>>(
    `/trash/photos?page=${page}&page_size=${pageSize}`,
  );
}

export function restoreTrashPhoto(id: number) {
  return request<{ status: "restored"; photo_id: number }>(
    `/trash/photos/${id}/restore`,
    { method: "POST" },
  );
}

export function permanentlyDeleteTrashPhoto(id: number) {
  return request<{
    status: "deleted";
    photo_id: number;
    missing_files: number;
  }>(`/trash/photos/${id}`, { method: "DELETE" });
}

export function updatePhoto(id: number, metadata: PhotoUpdate) {
  return request<Photo>(`/photos/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(metadata),
  });
}

export function uploadPhoto(file: File, allowVisualDuplicate = false) {
  const formData = new FormData();
  formData.append("file", file);
  if (allowVisualDuplicate) {
    formData.append("allow_visual_duplicate", "true");
  }

  return request<Photo>("/photos/upload", {
    method: "POST",
    body: formData,
  });
}

export function uploadPhotoBatch(files: File[]) {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));

  return request<BatchUploadResponse>("/photos/upload-batch", {
    method: "POST",
    body: formData,
  });
}

export function mockClassifyPhoto(id: number) {
  return request<Photo>(`/photos/${id}/mock-classify`, {
    method: "POST",
  });
}

export function classifyPhoto(id: number) {
  return request<ClassificationEnqueueResponse>(`/photos/${id}/classify`, {
    method: "POST",
  });
}

export function classifyPendingPhotos(photoIds?: number[]) {
  return request<ClassificationEnqueueResponse>("/photos/classify-pending", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(photoIds ? { photo_ids: photoIds } : {}),
  });
}

export function getClassificationJobs(options: {
  photoId?: number;
  batchId?: string;
  latestPerPhoto?: boolean;
} = {}) {
  const params = new URLSearchParams();
  if (options.photoId) params.set("photo_id", String(options.photoId));
  if (options.batchId) params.set("batch_id", options.batchId);
  if (options.latestPerPhoto) params.set("latest_per_photo", "true");
  const query = params.toString();
  return request<ClassificationJobCollection>(
    `/classification-jobs${query ? `?${query}` : ""}`,
  );
}

export function retryClassificationJob(id: number) {
  return request<ClassificationJob>(`/classification-jobs/${id}/retry`, {
    method: "POST",
  });
}
