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
  filename: string;
  error: string;
};

export type BatchUploadResponse = {
  uploaded: Photo[];
  failed: BatchUploadFailure[];
};

export type ClassifyPendingPhotoResult = {
  id: number;
  status: PhotoStatus | "failed";
  display_title: string | null;
  common_name: string | null;
  breed_guess: string | null;
  species_guess: string | null;
  error: string | null;
};

export type ClassifyPendingResponse = {
  total_found: number;
  classified: number;
  needs_review: number;
  failed: number;
  results: ClassifyPendingPhotoResult[];
};

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(formatErrorDetail(body?.detail));
  }

  return response.json() as Promise<T>;
}

export function imageUrl(
  type: "original" | "resized" | "thumbs",
  filename: string,
) {
  return `${API_BASE_URL}/images/${type}/${encodeURIComponent(filename)}`;
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
  return request<{ album_key: string; updated_animals: number }>(
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

export function getPhoto(id: string) {
  return request<Photo>(`/photos/${id}`);
}

export function deletePhoto(id: number) {
  return request<{ status: string; photo_id: number }>(`/photos/${id}`, {
    method: "DELETE",
  });
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

export function uploadPhoto(file: File) {
  const formData = new FormData();
  formData.append("file", file);

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
  return request<Photo>(`/photos/${id}/classify`, {
    method: "POST",
  });
}

export function classifyPendingPhotos() {
  return request<ClassifyPendingResponse>("/photos/classify-pending", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
}
