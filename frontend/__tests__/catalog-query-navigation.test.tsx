import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import { CatalogQuery, Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getCatalogPhotos: vi.fn(),
  getCatalogTaxa: vi.fn(),
  getClassificationJobs: vi.fn(),
  getTaxonomyFilters: vi.fn(),
  getSpeciesAlbums: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

function photo(title: string): Photo {
  return {
    id: 1,
    original_filename: "fox.jpg",
    stored_filename: "fox.jpg",
    resized_filename: "fox-resized.jpg",
    thumbnail_filename: "fox-thumb.jpg",
    display_title: title,
    common_name: null,
    breed_guess: null,
    species_guess: "Vulpes vulpes",
    category: "mammal",
    confidence: 0.9,
    description: null,
    tags: [],
    status: "classified",
    animal_id: 1,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    deleted_at: null,
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) => ({
    items: [photo(query.search || "Fox")],
    total: 96,
    page: query.page,
    page_size: query.page_size,
    total_pages: 2,
    facets: {
      active_total: 96,
      status_counts: { pending: 0, classified: 96, needs_review: 0 },
      categories: [{ value: "mammal", count: 96 }],
      uncategorized_count: 0,
    },
  }));
  api.getCatalogTaxa.mockResolvedValue({
    items: [],
    selected: {
      taxon_id: 7,
      label: "Red fox",
      scientific_name: "Vulpes vulpes",
      count: 12,
    },
    page: 1,
    page_size: 50,
    total: 0,
    total_pages: 0,
  });
  api.getClassificationJobs.mockResolvedValue({
    jobs: [],
    summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
  });
  api.getTaxonomyFilters.mockResolvedValue({
    classes: [], orders: [], families: [], genera: [], species: [],
  });
  api.getSpeciesAlbums.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 24 });
});

test("restores the complete catalog query and resynchronizes after popstate", async () => {
  window.history.replaceState(
    null,
    "",
    "/?catalog_page=2&catalog_search=fox&catalog_status=classified&catalog_category=mammal&catalog_taxon=7&catalog_sort=name&catalog_order=asc&catalog_layout=grouped",
  );
  render(<Home />);

  expect(await screen.findByDisplayValue("fox")).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Status" }).value).toBe("classified");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Category" }).value).toBe("mammal");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" }).value).toBe("name_asc");
  expect(screen.getByRole("button", { name: "Group by category" }).className).toContain("bg-white");

  window.history.pushState(null, "", "/?catalog_search=owl");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() =>
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search" }).value).toBe("owl"),
  );
  await waitFor(() =>
    expect(api.getCatalogPhotos).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, search: "owl" }),
      expect.any(AbortSignal),
    ),
  );
});

test("preserves catalog parameters while switching collection views", async () => {
  window.history.replaceState(null, "", "/?catalog_page=2&catalog_status=classified");
  render(<Home />);
  await screen.findByText("Page 2 of 2");

  await userEvent.click(screen.getByRole("button", { name: "album" }));
  expect(window.location.search).toContain("view=album");
  expect(window.location.search).toContain("catalog_page=2");
  expect(window.location.search).toContain("catalog_status=classified");

  await userEvent.click(screen.getByRole("button", { name: "list" }));
  expect(window.location.search).not.toContain("view=");
  expect(window.location.search).toContain("catalog_page=2");
});
