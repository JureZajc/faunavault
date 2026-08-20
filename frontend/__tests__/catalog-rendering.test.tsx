import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import { CatalogQuery, Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getCatalogPhotos: vi.fn(),
  getCatalogTaxa: vi.fn(),
  getClassificationJobs: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

function photo(id: number, title: string, category: string | null): Photo {
  return {
    id,
    original_filename: `${id}.jpg`, stored_filename: `${id}.jpg`,
    resized_filename: `${id}-resized.jpg`, thumbnail_filename: `${id}-thumb.jpg`,
    display_title: title, common_name: null, breed_guess: null,
    species_guess: null, category, confidence: null, description: null, tags: [],
    status: "classified", animal_id: id, content_sha256: null,
    original_size_bytes: null, media_type: "image/jpeg", deleted_at: null,
    created_at: "2026-08-12T08:00:00Z", updated_at: "2026-08-12T08:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  api.getCatalogTaxa.mockResolvedValue({ items: [], selected: null, page: 1, page_size: 50, total: 0, total_pages: 0 });
  api.getClassificationJobs.mockResolvedValue({ jobs: [], summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } });
});

test("renders one shared card path grouped by sorted category", async () => {
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) => ({
    items: [photo(1, "Zebra", "mammal"), photo(2, "Eagle", "bird"), photo(3, "Mystery", null)],
    total: 3, page: query.page, page_size: query.page_size, total_pages: 1,
    facets: { active_total: 3, status_counts: { pending: 0, classified: 3, needs_review: 0 }, categories: [{ value: "bird", count: 1 }, { value: "mammal", count: 1 }], uncategorized_count: 1 },
  }));
  window.history.replaceState(null, "", "/?catalog_layout=grouped");
  render(<Home />);

  expect(await screen.findByRole("heading", { name: "Eagle" })).toBeTruthy();
  const groupHeadings = screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent)
    .filter((text) => ["bird", "mammal", "Unknown"].includes(text ?? ""));
  expect(groupHeadings).toEqual(["bird", "mammal", "Unknown"]);
  expect(screen.getAllByRole("button", { name: "Move to Trash" })).toHaveLength(3);
  expect(screen.getByTitle("1.jpg").textContent).toBe("1.jpg");

  const listSwitch = screen.getByRole("button", { name: "list" });
  const layoutSwitch = screen.getByRole("button", { name: "Flat grid" });
  expect(listSwitch.className).toContain("min-w-0");
  expect(listSwitch.parentElement?.className).toContain("w-full");
  expect(layoutSwitch.className).toContain("min-w-0");
  expect(layoutSwitch.className).toContain("whitespace-normal");
  expect(layoutSwitch.parentElement?.className).toContain("w-full");
});

test("corrects an out-of-range page once without a fetch loop", async () => {
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) => ({
    items: query.page === 2 ? [photo(2, "Corrected page", "mammal")] : [],
    total: 2, page: query.page, page_size: query.page_size, total_pages: 2,
    facets: { active_total: 2, status_counts: { pending: 0, classified: 2, needs_review: 0 }, categories: [{ value: "mammal", count: 2 }], uncategorized_count: 0 },
  }));
  window.history.replaceState(null, "", "/?catalog_page=4");
  render(<Home />);

  expect(await screen.findByRole("heading", { name: "Corrected page" })).toBeTruthy();
  await waitFor(() => expect(window.location.search).toContain("catalog_page=2"));
  expect(api.getCatalogPhotos).toHaveBeenCalledTimes(2);
});
