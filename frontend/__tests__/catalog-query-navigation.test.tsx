import { render, screen, waitFor, within } from "@testing-library/react";
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
  createSmartCollection: vi.fn(),
  getSmartCollection: vi.fn(),
  updateSmartCollection: vi.fn(),
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
    captured_at: null, captured_at_offset_minutes: null,
    camera_make: null, camera_model: null, lens_model: null,
    image_width: null, image_height: null, latitude: null, longitude: null,
    deleted_at: null,
    reviewed_at: null,
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
  api.createSmartCollection.mockResolvedValue({ id: 8, name: "Foxes", query_valid: true });
  api.getSmartCollection.mockResolvedValue({ id: 7, name: "Birds", query_version: 1, query_valid: true, query_error: null, query: { sort: "created_at", order: "desc" }, created_at: "2026-01-01", updated_at: "2026-01-01" });
  api.updateSmartCollection.mockResolvedValue({ id: 7, name: "Birds", query_valid: true });
});

test("saves current List criteria without page or layout and includes pending search text", async () => {
  window.history.replaceState(null, "", "/?catalog_page=2&catalog_status=classified&catalog_layout=grouped&catalog_sort=name&catalog_order=asc");
  render(<Home />);
  await screen.findByRole("heading", { name: "Fox" });
  await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "fox");
  await userEvent.click(screen.getByRole("button", { name: "Save as Smart Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Create Smart Collection" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Smart Collection name" }), "Foxes");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create Smart Collection" }));
  await waitFor(() => expect(api.createSmartCollection).toHaveBeenCalledWith({
    name: "Foxes", query_version: 1,
    query: expect.objectContaining({ search: "fox", status: "classified", sort: "name", order: "asc" }),
  }));
  const savedQuery = api.createSmartCollection.mock.calls[0][0].query;
  expect(savedQuery).not.toHaveProperty("page");
  expect(savedQuery).not.toHaveProperty("page_size");
  expect(savedQuery).not.toHaveProperty("layout");
  await waitFor(() => expect(window.location.pathname).toBe("/collections/smart/8"));
});

test("edits a saved query through List controls and saves to the same collection", async () => {
  window.history.replaceState(null, "", "/?smart_edit=7&catalog_status=pending");
  render(<Home />);
  expect(await screen.findByText(/Editing Smart Collection “Birds”/)).toBeTruthy();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "classified");
  await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(api.updateSmartCollection).toHaveBeenCalledWith(7, {
    query_version: 1, query: expect.objectContaining({ status: "classified" }),
  }));
  await waitFor(() => expect(window.location.pathname).toBe("/collections/smart/7"));
});

test("restores the complete catalog query and resynchronizes after popstate", async () => {
  window.history.replaceState(
    null,
    "",
    "/?catalog_page=2&catalog_search=fox&catalog_status=classified&catalog_category=mammal&catalog_taxon=7&catalog_taken_from=2024-05-01&catalog_taken_to=2024-05-31&catalog_sort=name&catalog_order=asc&catalog_layout=grouped",
  );
  render(<Home />);

  expect(await screen.findByDisplayValue("fox")).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Status" }).value).toBe("classified");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Category" }).value).toBe("mammal");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" }).value).toBe("name_asc");
  expect(screen.getByLabelText<HTMLInputElement>("Taken from").value).toBe("2024-05-01");
  expect(screen.getByLabelText<HTMLInputElement>("Taken to").value).toBe("2024-05-31");
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

test("writes capture dates to the URL and reset clears both", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "Fox" });

  await userEvent.type(screen.getByLabelText("Taken from"), "2024-05-01");
  await waitFor(() =>
    expect(window.location.search).toContain("catalog_taken_from=2024-05-01"),
  );
  await userEvent.type(screen.getByLabelText("Taken to"), "2024-05-31");
  await waitFor(() =>
    expect(window.location.search).toContain("catalog_taken_to=2024-05-31"),
  );
  expect(api.getCatalogPhotos).toHaveBeenLastCalledWith(
    expect.objectContaining({
      taken_from: "2024-05-01",
      taken_to: "2024-05-31",
    }),
    expect.any(AbortSignal),
  );

  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() => expect(window.location.search).not.toContain("catalog_taken_"));
});

test("preserves catalog parameters while switching collection views", async () => {
  window.history.replaceState(null, "", "/?catalog_page=2&catalog_status=classified");
  render(<Home />);
  await screen.findByText("Page 2 of 2");

  await userEvent.click(screen.getByRole("link", { name: "Albums" }));
  expect(window.location.search).toContain("view=album");
  expect(window.location.search).toContain("catalog_page=2");
  expect(window.location.search).toContain("catalog_status=classified");

  await userEvent.click(screen.getByRole("link", { name: "List" }));
  expect(window.location.search).not.toContain("view=");
  expect(window.location.search).toContain("catalog_page=2");

  const navigation = screen.getByRole("navigation", { name: "Archive views" });
  expect(
    Array.from(navigation.querySelectorAll("a")).map((link) => link.textContent),
  ).toEqual(["List", "Timeline", "Map", "Albums", "Collections", "Review", "Trash"]);
  expect(screen.getByRole("link", { name: "Timeline" }).getAttribute("href"))
    .toBe("/timeline");
  expect(screen.getByRole("link", { name: "Map" }).getAttribute("href"))
    .toBe("/map");
});
