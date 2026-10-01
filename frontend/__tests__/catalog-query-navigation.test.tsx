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
  getEvent: vi.fn(),
  addEventPhotos: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

function photo(title: string): Photo {
  return {
    id: 1,
    original_filename: "fox.jpg",
    culling_state: null, is_favorite: false, rating: null,
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
    extracted_captured_at: null, extracted_captured_at_offset_minutes: null,
    extracted_latitude: null, extracted_longitude: null,
    capture_metadata_overridden: false, location_metadata_overridden: false,
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
  api.getEvent.mockImplementation(async (id) => ({ id, kind: "trip", title: `Trip ${id}`, start_date: "2026-08-12", end_date: "2026-08-17", location_label: null, notes: null, active_photo_count: 1, trash_photo_count: 0, undecided_count: 1, pick_count: 0, reject_count: 0, previews: [] }));
  api.addEventPhotos.mockResolvedValue({ event_id: 7, requested_count: 1, added_count: 1, already_present_count: 0 });
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

test("restores, edits, saves and clears curation criteria through URL state", async () => {
  window.history.replaceState(null, "", "/?catalog_favorites_only=1&catalog_rating_min=4&catalog_sort=rating");
  render(<Home />);
  await screen.findByRole("heading", { name: "Fox" });
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: "Favorites only" }).checked).toBe(true);
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Rating filter" }).value).toBe("min:4");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" }).value).toBe("rating_desc");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "View on Map" }).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save as Smart Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Create Smart Collection" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Smart Collection name" }), "Best photos");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create Smart Collection" }));
  expect(api.createSmartCollection).toHaveBeenCalledWith(expect.objectContaining({ query_version: 1, query: expect.objectContaining({ favorites_only: true, rating_min: 4, sort: "rating" }) }));
});

test("switches exact/minimum/unrated filters without combining them and follows history", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "Fox" });
  await userEvent.click(screen.getByRole("checkbox", { name: "Favorites only" }));
  await waitFor(() => expect(window.location.search).toContain("catalog_favorites_only=1"));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Rating filter" }), "exact:5");
  await waitFor(() => expect(window.location.search).toContain("catalog_rating=5"));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Rating filter" }), "unrated");
  await waitFor(() => expect(window.location.search).toContain("catalog_unrated=1"));
  expect(window.location.search).not.toContain("catalog_rating=");
  window.history.pushState(null, "", "/?catalog_rating_min=3&catalog_sort=rating&catalog_order=asc");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Rating filter" }).value).toBe("min:3"));
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort" }).value).toBe("rating_asc");
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() => expect(window.location.search).not.toMatch(/catalog_(rating|favorites|unrated)/));
});

test("restores culling filters, saves Smart criteria and opens the full List in Culling", async () => {
  window.history.replaceState(null, "", "/?catalog_culling_state=pick&catalog_favorites_only=1&catalog_page=2&catalog_layout=grouped");
  render(<Home />);
  await screen.findByRole("combobox", { name: "Culling filter" });
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Culling filter" }).value).toBe("pick");
  await waitFor(() => expect(api.getCatalogPhotos).toHaveBeenCalledWith(expect.objectContaining({ culling_state: "pick" }), expect.any(AbortSignal)));
  const href = screen.getByRole("link", { name: "Open in Culling" }).getAttribute("href")!;
  const params = new URL(href, "http://localhost").searchParams;
  expect(params.get("catalog_culling_state")).toBe("pick");
  expect(params.get("source")).toBe("list");
  expect(params.has("catalog_page") || params.has("catalog_layout")).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "View on Map" }).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Save as Smart Collection" }));
  const dialog = screen.getByRole("dialog");
  await userEvent.type(within(dialog).getByRole("textbox"), "Picks");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create Smart Collection" }));
  await waitFor(() => expect(api.createSmartCollection).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ culling_state: "pick" }) })));
  window.history.pushState(null, "", "/?catalog_culling_state=reject"); window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() => expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Culling filter" }).value).toBe("reject"));
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() => expect(window.location.search).not.toContain("catalog_culling_state"));
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
  ).toEqual(["List", "Timeline", "Map", "Albums", "Collections", "Trips & Events", "Review", "Culling", "Duplicates", "Trash"]);
  expect(screen.getByRole("link", { name: "Timeline" }).getAttribute("href"))
    .toBe("/timeline");
  expect(screen.getByRole("link", { name: "Map" }).getAttribute("href"))
    .toBe("/map");
});


test("List opens Map with supported membership filters and disables pending text search", async () => {
  window.history.replaceState(null, "", "/?catalog_page=2&catalog_category=bird&catalog_taxon=7&catalog_taken_from=2026-01-01&catalog_status=classified&catalog_sort=name&catalog_layout=grouped&smart_edit=7");
  render(<Home />);
  await screen.findByRole("heading", { name: "Fox" });
  expect(screen.getByRole("link", { name: "View on Map" }).getAttribute("href")).toBe("/map?catalog_status=classified&catalog_category=bird&catalog_taxon=7&catalog_taken_from=2026-01-01");
  await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "f");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "View on Map" }).disabled).toBe(true);
  expect(screen.getByText("Clear Import Session, text search, Favorite/Rating, and Culling filters to view these filters on Map.")).toBeTruthy();
});

test("List Event membership survives filters and prevents saving Smart criteria", async () => {
  window.history.replaceState(null, "", "/?catalog_event_id=7");
  render(<Home />);
  await screen.findByRole("heading", { name: "Trip: Trip 7" });
  expect(screen.queryByRole("button", { name: "Save as Smart Collection" })).toBeNull();
  expect(screen.getByText(/Trip\/Event membership cannot be saved/)).toBeTruthy();
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "classified");
  await waitFor(() => expect(api.getCatalogPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ event_id: 7, status: "classified" }), expect.any(AbortSignal)));
  expect(screen.getByRole("link", { name: "View on Map" }).getAttribute("href")).toContain("catalog_event_id=7");
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));
  await userEvent.click(await screen.findByRole("checkbox", { name: /Select photo 1:/ }));
  expect(screen.getByText("1 selected", { exact: true })).toBeTruthy();
  window.history.pushState(null, "", "/?catalog_event_id=8"); window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Trip: Trip 8" });
  await waitFor(() => expect(screen.queryByText("1 selected", { exact: true })).toBeNull());
});

test("List suggestion target does not scope membership; successful addition clears selection and stays in List", async () => {
  window.history.replaceState(null, "", "/?add_to_event=7&catalog_taken_from=2026-08-12&catalog_taken_to=2026-08-17");
  render(<Home />);
  await screen.findByRole("heading", { name: "Add Photos to Trip: Trip 7" });
  await screen.findByRole("heading", { name: "Fox" });
  expect(api.getCatalogPhotos.mock.calls[0][0]).toMatchObject({ taken_from: "2026-08-12", taken_to: "2026-08-17" });
  expect(api.getCatalogPhotos.mock.calls[0][0].event_id).toBeUndefined();
  await userEvent.click(screen.getByRole("button", { name: "Select Photos to add" }));
  await userEvent.click(screen.getByRole("checkbox", { name: /Select photo 1:/ }));
  await userEvent.click(screen.getByRole("button", { name: "Add selected to this Trip" }));
  await waitFor(() => expect(api.addEventPhotos).toHaveBeenCalledWith(7, [1]));
  await waitFor(() => expect(screen.queryByText("1 selected", { exact: true })).toBeNull());
  expect(window.location.pathname).toBe("/");
  expect(window.location.search).toContain("add_to_event=7");
});

test("changing addition target clears selection; current dates preserve visible search and refresh copied date filters", async () => {
  window.history.replaceState(null, "", "/?add_to_event=7&catalog_taken_from=2025-01-01&catalog_taken_to=2025-01-02&catalog_search=fox");
  render(<Home />);
  await screen.findByRole("heading", { name: "Add Photos to Trip: Trip 7" });
  await screen.findByRole("heading", { name: "fox" });
  await userEvent.click(screen.getByRole("button", { name: "Select Photos to add" }));
  await userEvent.click(screen.getByRole("checkbox", { name: /Select photo 1:/ }));
  window.history.pushState(null, "", "/?add_to_event=8&catalog_search=fox"); window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Add Photos to Trip: Trip 8" });
  await waitFor(() => expect(screen.queryByText("1 selected", { exact: true })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Use current Trip/Event dates" }));
  expect(window.location.search).toContain("catalog_taken_from=2026-08-12");
  expect(window.location.search).toContain("catalog_taken_to=2026-08-17");
  expect(window.location.search).toContain("catalog_search=fox");
  expect(window.location.search).toContain("add_to_event=8");
});
