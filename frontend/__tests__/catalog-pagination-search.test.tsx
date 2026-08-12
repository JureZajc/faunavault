import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import { CatalogQuery, Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getCatalogPhotos: vi.fn(),
  getCatalogTaxa: vi.fn(),
  getClassificationJobs: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return { ...original, ...api };
});

function photo(id: number, title: string): Photo {
  return {
    id,
    original_filename: `${title.toLowerCase().replaceAll(" ", "-")}.jpg`,
    stored_filename: `${id}.jpg`,
    resized_filename: `${id}-resized.jpg`,
    thumbnail_filename: `${id}-thumb.jpg`,
    display_title: title,
    common_name: null,
    breed_guess: null,
    species_guess: null,
    category: "mammal",
    confidence: null,
    description: null,
    tags: [],
    status: "classified",
    animal_id: id,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    deleted_at: null,
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
  };
}

function catalogPage(query: CatalogQuery) {
  const item = query.page === 2 ? photo(2, "Page two fox") : photo(1, "Page one fox");
  return {
    items: [item],
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) =>
    catalogPage(query),
  );
  api.getClassificationJobs.mockResolvedValue({
    jobs: [],
    summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
  });
  api.getCatalogTaxa.mockImplementation(async (page: number) => ({
    items: [
      {
        taxon_id: page,
        label: page === 1 ? "Red fox" : "Arctic fox",
        scientific_name: page === 1 ? "Vulpes vulpes" : "Vulpes lagopus",
        count: page === 1 ? 20 : 4,
      },
    ],
    selected: null,
    page,
    page_size: 50,
    total: 2,
    total_pages: 2,
  }));
});

test("loads a direct catalog page and preserves it in detail return navigation", async () => {
  window.history.replaceState(null, "", "/?catalog_page=2");
  render(<Home />);

  const heading = await screen.findByRole("heading", { name: "Page two fox" });
  expect(api.getCatalogPhotos).toHaveBeenCalledWith(
    expect.objectContaining({ page: 2, page_size: 48 }),
    expect.any(AbortSignal),
  );
  expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  const link = within(heading.closest("article")!).getAllByRole("link")[0];
  expect(link.getAttribute("href")).toContain(
    encodeURIComponent("/?catalog_page=2"),
  );
});

test("debounces backend search, resets the page, and stores it in the URL", async () => {
  window.history.replaceState(null, "", "/?catalog_page=2");
  render(<Home />);
  await screen.findByRole("heading", { name: "Page two fox" });

  await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "red fox");
  await waitFor(
    () =>
      expect(api.getCatalogPhotos).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, search: "red fox" }),
        expect.any(AbortSignal),
      ),
    { timeout: 1500 },
  );
  expect(window.location.search).toContain("catalog_search=red+fox");
  expect(window.location.search).not.toContain("catalog_page");
});

test("loads verified taxon options lazily and appends bounded pages", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "Page one fox" });
  expect(api.getCatalogTaxa).not.toHaveBeenCalled();

  const selector = screen.getByRole("combobox", { name: "Verified taxon" });
  selector.focus();
  await waitFor(() => expect(api.getCatalogTaxa).toHaveBeenCalledWith(1, 50, undefined));
  expect(await screen.findByRole("option", { name: "Red fox (20)" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Load more taxa" }));
  expect(await screen.findByRole("option", { name: "Arctic fox (4)" })).toBeTruthy();
});
