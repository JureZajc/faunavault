import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import GearBrowser from "../app/gear/gear-browser";
import CatalogGearFilter from "../app/components/catalog/catalog-gear-filter";
import ArchiveNavigation from "../app/components/archive-navigation";
import MapBrowser from "../app/map/map-browser";
import { useCatalogQueryState } from "../app/hooks/use-catalog-query-state";
import { CatalogGear, getCatalogPhotos, getCullingWorkspace } from "../app/lib/api";
import { cameraLabel, DEFAULT_CATALOG_STATE, equipmentQuery, gearListHref, mapListHref, parseCatalogState, writeCatalogState } from "../app/lib/catalog-query";
import { savedQueryFromState } from "../app/lib/smart-collections";

const api = vi.hoisted(() => ({ getCatalogGear: vi.fn(), getPhotoMapPoints: vi.fn(), getCatalogFacets: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));
vi.mock("../app/components/maps/map-boundaries", () => ({ ArchivePhotoMap: () => null }));

const gear: CatalogGear = {
  active_total: 10, distinct_camera_models: 2, distinct_lens_models: 2,
  unknown_camera_count: 1, unknown_lens_count: 3, camera_total: 3, lens_total: 2, page: 1, page_size: 100,
  cameras: [
    { camera_make: "Canon", camera_model: "Canon EOS R5", count: 3, percentage: 30 },
    { camera_make: "Canon", camera_model: null, count: 1, percentage: 10 },
    { camera_make: null, camera_model: "Z9", count: 5, percentage: 50 },
  ],
  lenses: [{ lens_model: "RF100-500mm", count: 3, percentage: 30 }, { lens_model: "Zoom", count: 4, percentage: 40 }],
};

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  api.getCatalogGear.mockImplementation(async (search = "", sort = "name", page = 1) => ({ ...gear, page,
    cameras: gear.cameras.filter((camera) => cameraLabel(camera).toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === "count" ? b.count - a.count : cameraLabel(a).localeCompare(cameraLabel(b))),
    lenses: gear.lenses.filter((lens) => lens.lens_model.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === "count" ? b.count - a.count : a.lens_model.localeCompare(b.lens_model)),
  }));
  api.getCatalogFacets.mockResolvedValue({ active_total: 10, status_counts: {}, categories: [], uncategorized_count: 0 });
  api.getPhotoMapPoints.mockResolvedValue([]);
});

test("Explorer loading, overview, partial identities, links, search and sorting", async () => {
  render(<GearBrowser />);
  expect(screen.getByText("Loading equipment…")).toBeTruthy();
  const cameras = await screen.findByRole("region", { name: "Cameras" });
  await within(cameras).findByRole("link", { name: /^Canon EOS R5/ });
  expect(screen.getByText("10 active Photos")).toBeTruthy();
  expect(screen.getByText("2 distinct camera models")).toBeTruthy();
  expect(within(cameras).getByRole("link", { name: /^Canon 1/ }).getAttribute("href")).toContain("catalog_camera_model=");
  expect(screen.getByRole("link", { name: "1 Photos without camera information" }).getAttribute("href")).toBe("/?catalog_unknown_camera=1");
  expect(screen.getByRole("link", { name: "3 Photos without lens information" }).getAttribute("href")).toBe("/?catalog_unknown_lens=1");
  expect(screen.getByRole("link", { name: /^RF100-500mm/ }).getAttribute("href")).toBe("/?catalog_lens_model=RF100-500mm");
  await userEvent.selectOptions(screen.getByLabelText("Sort equipment"), "count");
  await waitFor(() => expect(within(screen.getByRole("region", { name: "Cameras" })).getAllByRole("link")[0].textContent).toContain("Z9"));
  await userEvent.type(screen.getByLabelText("Search cameras and lenses"), "nothing");
  await screen.findByText("No cameras match your search.");
  expect(screen.getByText("No lenses match your search.")).toBeTruthy();
});

test("Explorer empty, error and retry", async () => {
  api.getCatalogGear.mockRejectedValueOnce(new Error("Equipment unavailable")).mockResolvedValue({ ...gear, active_total: 0, cameras: [], lenses: [] });
  render(<GearBrowser />);
  await screen.findByText("Equipment unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Retry equipment" }));
  await screen.findByText(/No active Photos yet/);
});

function Harness() {
  const query = useCatalogQueryState();
  return <><CatalogGearFilter value={query.catalogState} onChange={query.setEquipmentFilters} /><button onClick={query.clearFilters}>Clear all filters</button><input aria-label="General search" value={query.searchInput} onChange={(event) => query.setSearchInput(event.target.value)} /></>;
}

test("equipment dropdowns combine, clear, reset pages, preserve URL and browser history", async () => {
  window.history.replaceState(null, "", "/?catalog_page=3&catalog_tag=bird&catalog_rating=4");
  render(<Harness />);
  await userEvent.click(screen.getByLabelText("Camera model", { exact: true }));
  await screen.findByRole("option", { name: "Canon EOS R5" });
  await userEvent.selectOptions(screen.getByLabelText("Camera model", { exact: true }), JSON.stringify("Canon EOS R5"));
  await userEvent.selectOptions(screen.getByLabelText("Lens model", { exact: true }), JSON.stringify("RF100-500mm"));
  expect(window.location.search).toContain("catalog_camera_model=Canon+EOS+R5");
  expect(window.location.search).toContain("catalog_lens_model=RF100-500mm");
  expect(window.location.search).toContain("catalog_tag=bird");
  expect(window.location.search).toContain("catalog_rating=4");
  expect(window.location.search).not.toContain("catalog_page");
  await userEvent.click(screen.getByRole("button", { name: "Remove lens model filter" }));
  await act(async () => window.history.back());
  await screen.findByRole("button", { name: "Remove lens model filter" });
  await act(async () => window.history.forward());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove lens model filter" })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Clear equipment filters" }));
  const unknown = screen.getByLabelText("Photos without camera information");
  unknown.focus(); await userEvent.keyboard(" ");
  expect((unknown as HTMLInputElement).checked).toBe(true);
  expect(window.location.search).toContain("catalog_unknown_camera=1");
  await userEvent.selectOptions(screen.getByLabelText("Camera manufacturer", { exact: true }), JSON.stringify("Canon"));
  expect(window.location.search).not.toContain("catalog_unknown_camera");
  await userEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
  expect(window.location.search).toBe("");
});

test("pending general search preserves latest equipment choices", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByLabelText("Camera model", { exact: true }));
  await screen.findByRole("option", { name: "Canon EOS R5" });
  await userEvent.type(screen.getByLabelText("General search"), "bird");
  await userEvent.selectOptions(screen.getByLabelText("Camera model", { exact: true }), JSON.stringify("Canon EOS R5"));
  await waitFor(() => expect(window.location.search).toContain("catalog_search=bird"));
  expect(window.location.search).toContain("catalog_camera_model=Canon+EOS+R5");
});

test("URL roundtrip preserves empty partial components, conflicts, and unsupported saves", () => {
  const state = { ...DEFAULT_CATALOG_STATE, camera_make: "", camera_model: "Canon EOS R5", lens_model: "A%_+&", unknown_lens: true };
  const restored = parseCatalogState(writeCatalogState(new URLSearchParams(), state));
  expect(equipmentQuery(restored)).toEqual(equipmentQuery(state));
  expect(mapListHref(restored)).toContain("catalog_camera_make=");
  expect(gearListHref({ camera_make: "", camera_model: "Z9" })).toContain("catalog_camera_make=&catalog_camera_model=Z9");
  expect(() => savedQueryFromState(restored, "")).toThrow(/Equipment filters cannot be saved/);
  for (const criteria of [{ unknown_camera: true }, { unknown_lens: true }, { camera_make: "" }, { camera_model: "Z9" }, { lens_model: "RF" }]) {
    expect(() => savedQueryFromState({ ...DEFAULT_CATALOG_STATE, ...criteria }, "")).toThrow(/version-1 Smart Collections/);
  }
  expect(cameraLabel({ camera_make: "Canon", camera_model: "CANON EOS R5" })).toBe("CANON EOS R5");
});

test("unsupported archive navigation explains equipment and retains List/Culling filters", async () => {
  render(<ArchiveNavigation active="list" catalogState={{ ...DEFAULT_CATALOG_STATE, lens_model: "RF" }} />);
  await userEvent.click(screen.getByRole("link", { name: "Map" }));
  expect(screen.getByRole("alert").textContent).toContain("equipment filters");
  expect(screen.getByRole("link", { name: "Open the filtered List" }).getAttribute("href")).toContain("catalog_lens_model=RF");
  expect(screen.getByRole("link", { name: "Culling" }).getAttribute("href")).toContain("catalog_lens_model=RF");
});

test("direct Map URLs block equipment and offer List preserving all criteria", async () => {
  window.history.replaceState(null, "", "/map?catalog_camera_make=&catalog_camera_model=Z9");
  render(<MapBrowser focusPhotoId={null} />);
  await screen.findByText(/Equipment filters are not supported on Map/);
  expect(api.getPhotoMapPoints).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "View in List" }).getAttribute("href")).toContain("catalog_camera_make=&catalog_camera_model=Z9");
  await userEvent.click(screen.getByRole("button", { name: "Remove unsupported filters" }));
  await waitFor(() => expect(window.location.search).not.toContain("catalog_camera"));
});

test("List and Culling API serialize all equipment criteria including missing components", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  await getCatalogPhotos({ ...DEFAULT_CATALOG_STATE, camera_make: "", camera_model: "Z9", unknown_lens: true });
  await getCullingWorkspace({ ...DEFAULT_CATALOG_STATE, unknown_camera: true, lens_model: "RF" });
  expect(String(fetch.mock.calls[0][0])).toContain("camera_make=&camera_model=Z9&unknown_lens=true");
  expect(String(fetch.mock.calls[1][0])).toContain("lens_model=RF&unknown_camera=true");
});
