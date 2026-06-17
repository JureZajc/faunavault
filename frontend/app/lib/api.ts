export type PhotoStatus = "pending" | "classified" | "needs_review";

export type Photo = {
  id: number;
  original_filename: string;
  stored_filename: string;
  resized_filename: string;
  thumbnail_filename: string;
  common_name: string | null;
  species_guess: string | null;
  category: string | null;
  confidence: number | null;
  description: string | null;
  tags: string[];
  status: PhotoStatus;
  created_at: string;
  updated_at: string;
};

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export function imageUrl(
  type: "original" | "resized" | "thumbs",
  filename: string,
) {
  return `${API_BASE_URL}/images/${type}/${encodeURIComponent(filename)}`;
}

export function getPhotos() {
  return request<Photo[]>("/photos");
}

export function getPhoto(id: string) {
  return request<Photo>(`/photos/${id}`);
}

export function uploadPhoto(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return request<Photo>("/photos/upload", {
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
