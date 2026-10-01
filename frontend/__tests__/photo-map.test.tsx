import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import MapBrowser from "../app/map/map-browser";
import { ApiError, PhotoMapPoint } from "../app/lib/api";
import {
  parsePhotoFocusId,
  photoMapCapturedDate,
  photoMapDetailHref,
  photoMapMarkerLabel,
  photoMapPointTitle,
} from "../app/lib/photo-map";

const api = vi.hoisted(() => ({
  getPhotoMapPoints: vi.fn(),
  getCatalogFacets: vi.fn(),
  getCatalogTaxa: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

vi.mock("../app/components/maps/map-boundaries", () => ({
  ArchivePhotoMap: ({
    points,
    focusPhotoId,
    mapHref,
  }: {
    points: PhotoMapPoint[];
    focusPhotoId: number | null;
    mapHref?: string;
  }) => (
    <div
      role="region"
      aria-label="Mock archive map"
      data-count={points.length}
      data-focus={focusPhotoId ?? ""}
      data-href={mapHref}
    />
  ),
  PhotoLocationMap: () => null,
}));

function point(overrides: Partial<PhotoMapPoint> = {}): PhotoMapPoint {
  return {
    id: 17,
    latitude: 46.12345,
    longitude: 14.54321,
    thumbnail_filename: "roe-deer-thumb.jpg",
    original_filename: "roe-deer.jpg",
    display_title: "Woodland visitor",
    common_name: "Roe deer",
    species_guess: "Capreolus capreolus",
    captured_at: "2024-05-24T18:42:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getCatalogFacets.mockResolvedValue({ categories: [{ value: "bird", count: 2 }], uncategorized_count: 1 });
  api.getCatalogTaxa.mockResolvedValue({ items: [], selected: { taxon_id: 7, label: "Robin", count: 1 }, page: 1, total_pages: 1 });
  window.history.replaceState(null, "", "/map");
});

test.each(["", "&catalog_rating=5&catalog_unrated=1", "&catalog_culling_state=pick"])("unsupported curation URLs block map results and preserve criteria when returning to List %s", async (extra) => {
  window.history.replaceState(null, "", `/map?catalog_favorites_only=1&catalog_rating_min=4&catalog_category=bird${extra}`);
  render(<MapBrowser focusPhotoId={null} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Favorite/Rating filters are not supported"));
  expect(api.getPhotoMapPoints).not.toHaveBeenCalled();
  const href = screen.getByRole("link", { name: "View in List" }).getAttribute("href");
  expect(href).toContain("catalog_favorites_only=1");
  expect(href).toContain("catalog_rating_min=4");
  if (extra.includes("catalog_rating=5")) {
    expect(href).toContain("catalog_rating=5");
    expect(href).toContain("catalog_unrated=1");
  }
  if (extra.includes("catalog_culling_state")) expect(href).toContain("catalog_culling_state=pick");
  api.getPhotoMapPoints.mockResolvedValue([point()]);
  await userEvent.click(screen.getByRole("button", { name: "Remove unsupported filters" }));
  await waitFor(() => expect(api.getPhotoMapPoints).toHaveBeenCalled());
  expect(window.location.search).toBe("?catalog_category=bird");
});

test("parses only one positive safe focus ID", () => {
  expect(parsePhotoFocusId("17")).toBe(17);
  expect(parsePhotoFocusId("0")).toBeNull();
  expect(parsePhotoFocusId("-1")).toBeNull();
  expect(parsePhotoFocusId("17.5")).toBeNull();
  expect(parsePhotoFocusId(["17", "18"])).toBeNull();
  expect(parsePhotoFocusId("99999999999999999999")).toBeNull();
});

test("builds compact preview metadata and a focused return link", () => {
  const location = point();
  expect(photoMapPointTitle(location)).toBe("Woodland visitor");
  expect(photoMapMarkerLabel(location)).toBe(
    "Open map preview for Woodland visitor",
  );
  expect(photoMapCapturedDate(location)).toBe("May 24, 2024");
  expect(photoMapDetailHref(location)).toBe(
    "/photos/17?returnTo=%2Fmap%3Fphoto%3D17",
  );
  expect(
    photoMapPointTitle(
      point({ display_title: " ", common_name: null, original_filename: "fallback.jpg" }),
    ),
  ).toBe("fallback.jpg");
});

test("shows loading and then passes points plus focus to the map boundary", async () => {
  let resolvePoints: (points: PhotoMapPoint[]) => void = () => undefined;
  api.getPhotoMapPoints.mockReturnValue(
    new Promise<PhotoMapPoint[]>((resolve) => {
      resolvePoints = resolve;
    }),
  );
  render(<MapBrowser focusPhotoId={17} />);

  expect(screen.getByRole("status").textContent).toContain("Loading");
  resolvePoints([point(), point({ id: 18 })]);

  const map = await screen.findByRole("region", { name: "Mock archive map" });
  expect(map.getAttribute("data-count")).toBe("2");
  expect(map.getAttribute("data-focus")).toBe("17");
  expect(screen.getByText("2 mapped photos")).toBeTruthy();
  expect(
    screen.getAllByRole("link").map((link) => link.textContent),
  ).toEqual(["List", "Timeline", "Map", "Albums", "Collections", "Review", "Culling", "Duplicates", "Trash", "View in List"]);
  expect(screen.getByRole("link", { name: "Map" }).getAttribute("aria-current"))
    .toBe("page");
});

test("shows the purposeful empty state without mounting a map", async () => {
  api.getPhotoMapPoints.mockResolvedValue([]);
  render(<MapBrowser focusPhotoId={null} />);

  expect(await screen.findByText("No matching photos with location data")).toBeTruthy();
  expect(
    screen.getByText("Use View in List to see all matching photos, including those without GPS."),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Mock archive map" })).toBeNull();
});

test("shows a safe error and retries the map request", async () => {
  api.getPhotoMapPoints
    .mockRejectedValueOnce(new Error("private backend detail"))
    .mockResolvedValueOnce([point()]);
  render(<MapBrowser focusPhotoId={999} />);

  expect(await screen.findByText("Could not load photo locations")).toBeTruthy();
  expect(screen.queryByText("private backend detail")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.getPhotoMapPoints).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("region", { name: "Mock archive map" })).toBeTruthy();
});


test("restores Map criteria, summary, and List navigation without List state", async () => {
  window.history.replaceState(null, "", "/map?photo=17&catalog_category=bird&catalog_taxon=7&catalog_status=classified&catalog_taken_from=2026-01-01&catalog_taken_to=2026-12-31&catalog_page=3&catalog_sort=name&catalog_layout=grouped");
  api.getPhotoMapPoints.mockResolvedValue([point()]);
  render(<MapBrowser focusPhotoId={17} />);
  await screen.findByText("1 mapped photo");
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Category" }).value).toBe("bird");
  expect(screen.getByLabelText<HTMLInputElement>("Taken from").value).toBe("2026-01-01");
  await screen.findByText(/Taxon: Robin/);
  const expected = "catalog_status=classified&catalog_category=bird&catalog_taxon=7&catalog_taken_from=2026-01-01&catalog_taken_to=2026-12-31";
  expect(screen.getByRole("link", { name: "View in List" }).getAttribute("href")).toBe(`/?${expected}`);
  expect(screen.getByRole("region", { name: "Mock archive map" }).getAttribute("data-href")).toBe(`/map?${expected}`);
  expect(api.getPhotoMapPoints.mock.calls[0][0]).toEqual({ category: "bird", taxon_id: 7, status: "classified", taken_from: "2026-01-01", taken_to: "2026-12-31" });
  expect(photoMapDetailHref(point(), `/map?${expected}`)).toContain(encodeURIComponent(`/map?${expected}&photo=17`));
});

test("filters update membership and URL, Clear and browser history restore state", async () => {
  api.getPhotoMapPoints.mockImplementation(async (query) => query.category ? [point()] : [point(), point({ id: 18 })]);
  render(<MapBrowser focusPhotoId={null} />);
  await screen.findByText("2 mapped photos");
  const originalMap = screen.getByRole("region", { name: "Mock archive map" });
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "bird");
  await screen.findByText("1 mapped photo");
  expect(window.location.search).toBe("?catalog_category=bird");
  expect(screen.getByRole("region", { name: "Mock archive map" })).toBe(originalMap);
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByText("2 mapped photos");
  expect(window.location.search).toBe("");
  act(() => window.history.back());
  await waitFor(() => expect(window.location.search).toBe("?catalog_category=bird"));
  await screen.findByText("1 mapped photo");
  act(() => window.history.forward());
  await screen.findByText("2 mapped photos");
  expect(api.getCatalogFacets).toHaveBeenCalledTimes(1);
});

test("does not apply unsupported URL search and offers removal or equivalent List", async () => {
  window.history.replaceState(null, "", "/map?catalog_search=fox&catalog_category=bird");
  api.getPhotoMapPoints.mockResolvedValue([point()]);
  render(<MapBrowser focusPhotoId={null} />);
  expect(screen.getByRole("alert").textContent).toContain("Text search is not supported");
  expect(screen.getByRole("link", { name: "View in List" }).getAttribute("href")).toBe("/?catalog_search=fox&catalog_category=bird");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(api.getPhotoMapPoints).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Remove text search" }));
  await screen.findByText("1 mapped photo");
  expect(window.location.search).toBe("?catalog_category=bird");
});

test("keeps URL values visible when taxonomy and facet requests fail, then retries", async () => {
  window.history.replaceState(null, "", "/map?catalog_taxon=7&catalog_category=bird");
  api.getPhotoMapPoints.mockResolvedValue([point()]);
  api.getCatalogFacets.mockRejectedValueOnce(new Error("unavailable"));
  api.getCatalogTaxa.mockRejectedValueOnce(new Error("Could not load verified taxa"));
  render(<MapBrowser focusPhotoId={null} />);
  await screen.findByText("1 mapped photo");
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  expect(await screen.findByText("Taxon #7")).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Verified taxon" }).value).toBe("7");
  await userEvent.click(await screen.findByRole("button", { name: "Retry taxa" }));
  await userEvent.click(screen.getByRole("button", { name: "Retry filter options" }));
  await screen.findByText(/Taxon: Robin/);
  await waitFor(() => expect(screen.queryByText(/Could not load filter options/)).toBeNull());
});

test("shows date validation, supports fixing dates and malformed URL normalization", async () => {
  window.history.replaceState(null, "", "/map?catalog_status=invalid&catalog_taxon=bad&catalog_taken_from=bad&catalog_taken_to=2026-01-01");
  api.getPhotoMapPoints.mockRejectedValueOnce(new ApiError("taken_from must be on or before taken_to", 422)).mockResolvedValue([]);
  render(<MapBrowser focusPhotoId={null} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("taken_from must be"));
  expect(api.getPhotoMapPoints.mock.calls[0][0]).toEqual({ taken_to: "2026-01-01" });
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  fireEvent.change(screen.getByLabelText("Taken to"), { target: { value: "2026-12-31" } });
  await screen.findByText("0 mapped photos");
});

test("aborts superseded requests and never displays their late response", async () => {
  let resolveOld: (points: PhotoMapPoint[]) => void = () => undefined;
  api.getPhotoMapPoints.mockReturnValueOnce(new Promise<PhotoMapPoint[]>((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce([point()]);
  render(<MapBrowser focusPhotoId={null} />);
  await waitFor(() => expect(api.getPhotoMapPoints).toHaveBeenCalledTimes(1));
  const signal = api.getPhotoMapPoints.mock.calls[0][1] as AbortSignal;
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "classified");
  await screen.findByText("1 mapped photo");
  expect(signal.aborted).toBe(true);
  await act(async () => resolveOld([point(), point({ id: 18 })]));
  expect(screen.getByText("1 mapped photo")).toBeTruthy();
});

test("refreshes effective location data when returning to a visible browser", async () => {
  api.getPhotoMapPoints.mockResolvedValueOnce([point()]).mockResolvedValueOnce([]);
  render(<MapBrowser focusPhotoId={null} />);
  await screen.findByText("1 mapped photo");
  act(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await screen.findByText("0 mapped photos");
  expect(screen.queryByRole("region", { name: "Mock archive map" })).toBeNull();
});


test("Unknown, verified Taxon paging, and date controls share catalog semantics", async () => {
  api.getPhotoMapPoints.mockResolvedValue([point()]);
  api.getCatalogTaxa.mockResolvedValueOnce({ items: [{ taxon_id: 7, label: "Robin", count: 1 }], selected: null, page: 1, total_pages: 2 })
    .mockResolvedValueOnce({ items: [{ taxon_id: 8, label: "Owl", count: 2 }], selected: null, page: 2, total_pages: 2 });
  render(<MapBrowser focusPhotoId={null} />);
  await screen.findByText("1 mapped photo");
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "__unknown__");
  await waitFor(() => expect(api.getPhotoMapPoints.mock.lastCall?.[0]).toEqual({ uncategorized: true }));
  await userEvent.click(screen.getByRole("combobox", { name: "Verified taxon" }));
  await userEvent.click(await screen.findByRole("button", { name: "Load more taxa" }));
  await screen.findByText("Owl (2)");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Verified taxon" }), "8");
  fireEvent.change(screen.getByLabelText("Taken from"), { target: { value: "2026-01-01" } });
  await waitFor(() => expect(api.getPhotoMapPoints.mock.lastCall?.[0]).toEqual({ uncategorized: true, taxon_id: 8, taken_from: "2026-01-01" }));
  expect(window.location.search).toBe("?catalog_uncategorized=1&catalog_taxon=8&catalog_taken_from=2026-01-01");
  expect(screen.queryByRole("searchbox")).toBeNull();
});

test("suppresses previous markers and count after a filtered projection fails", async () => {
  api.getPhotoMapPoints.mockResolvedValueOnce([point()]).mockRejectedValueOnce(new Error("unavailable"));
  render(<MapBrowser focusPhotoId={null} />);
  await screen.findByText("1 mapped photo");
  const map = screen.getByRole("region", { name: "Mock archive map" });
  await userEvent.click(screen.getByRole("button", { name: "Filters" }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "pending");
  await screen.findByText("Could not load photo locations");
  expect(screen.queryByText("1 mapped photo")).toBeNull();
  expect(screen.queryByRole("region", { name: "Mock archive map" })).toBeNull();
  expect(map.isConnected).toBe(true);
});
