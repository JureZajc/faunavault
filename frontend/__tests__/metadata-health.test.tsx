import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import MetadataHealthPage from "../app/metadata-health/page";
import Home from "../app/page";
import MapBrowser from "../app/map/map-browser";
import ArchiveNavigation from "../app/components/archive-navigation";
import { CatalogQuery, getCullingWorkspace, MetadataHealth, MetadataIssue } from "../app/lib/api";
import { DEFAULT_CATALOG_STATE, mapListHref, metadataIssueLabels, parseCatalogState, writeCatalogState } from "../app/lib/catalog-query";
import { useCatalogQueryState } from "../app/hooks/use-catalog-query-state";
import { savedQueryFromState } from "../app/lib/smart-collections";

const api = vi.hoisted(() => ({ getMetadataHealth: vi.fn(), getCatalogPhotos: vi.fn(), getClassificationJobs: vi.fn(), getPhotoMapPoints: vi.fn(), getCatalogFacets: vi.fn(), getSmartCollection: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));
vi.mock("../app/components/maps/map-boundaries", () => ({ ArchivePhotoMap: () => null }));

const health: MetadataHealth = { active_total: 10, missing_capture: 3, missing_gps: 4, missing_both: 2, missing_either: 5, complete: 5, completeness_percentage: 50 };

beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  api.getMetadataHealth.mockResolvedValue(health);
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) => ({ items: [], total: 0, total_pages: 0, page: query.page, page_size: 48, facets: { active_total: 10, status_counts: { pending: 0, classified: 10, needs_review: 0 }, categories: [], uncategorized_count: 0 } }));
  api.getClassificationJobs.mockResolvedValue({ jobs: [], summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } });
  api.getCatalogFacets.mockResolvedValue({ active_total: 10, status_counts: {}, categories: [], uncategorized_count: 0 });
  api.getPhotoMapPoints.mockResolvedValue([]);
  api.getSmartCollection.mockResolvedValue({ id: 7, name: "Birds", query_version: 1, query_valid: true, query: { sort: "created_at", order: "desc" } });
});

test("health renders semantic linked metrics, completeness and existing repair guidance", async () => {
  render(<MetadataHealthPage />);
  expect(screen.getByRole("status").textContent).toContain("Loading Metadata Health");
  await screen.findByRole("progressbar", { name: "Metadata completeness" });
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");
  const counts = screen.getByLabelText("Metadata health counts");
  expect(within(counts).getByRole("link", { name: "Total active Photos" }).getAttribute("href")).toBe("/");
  for (const [issue, label] of Object.entries(metadataIssueLabels)) {
    const link = within(counts).getByRole("link", { name: label });
    expect(link.getAttribute("href")).toBe(`/?catalog_metadata_issue=${issue}`);
    expect(link.closest("div")?.textContent).toContain(String(health[issue as MetadataIssue]));
  }
  expect(screen.getByText(/Import timestamps are never substituted/)).toBeTruthy();
  expect(screen.getByText(/Restoration verifies and re-reads/)).toBeTruthy();
  const complete = screen.getByRole("link", { name: "Browse complete Photos: 50%" });
  complete.focus();
  expect(document.activeElement).toBe(complete);
  expect(complete.className).toContain("min-h-11");
});

test("empty health and keyboard retry do not leak errors", async () => {
  api.getMetadataHealth.mockRejectedValueOnce(new Error("private path"));
  api.getMetadataHealth.mockResolvedValue(Object.fromEntries(Object.keys(health).map((key) => [key, 0])));
  render(<MetadataHealthPage />);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load Metadata Health");
  expect(screen.queryByText("private path")).toBeNull();
  screen.getByRole("button", { name: "Retry" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByText(/No active Photos yet/)).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("0");
  expect(api.getMetadataHealth).toHaveBeenCalledTimes(2);
});

test("unmount aborts health requests and ignores a late response", async () => {
  let resolve!: (data: MetadataHealth) => void;
  api.getMetadataHealth.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const view = render(<MetadataHealthPage />);
  await waitFor(() => expect(api.getMetadataHealth).toHaveBeenCalledOnce());
  const signal = api.getMetadataHealth.mock.calls[0][0] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(health));
});

function FilterHarness() {
  const query = useCatalogQueryState();
  return <><label>Metadata completeness<select value={query.catalogState.metadata_issue ?? ""} onChange={(event) => query.setMetadataIssue(event.target.value as MetadataIssue || undefined)}><option value="">All Photos</option>{Object.entries(metadataIssueLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button onClick={query.clearFilters}>Reset filters</button><output>{query.catalogState.metadata_issue}</output></>;
}

test("URL persistence, reload, history and clearing preserve other criteria and reset pagination", async () => {
  window.history.replaceState(null, "", "/?catalog_metadata_issue=missing_gps&catalog_page=3&catalog_tag=fox&catalog_search=forest");
  const view = render(<FilterHarness />);
  expect((screen.getByLabelText("Metadata completeness") as HTMLSelectElement).value).toBe("missing_gps");
  await userEvent.selectOptions(screen.getByLabelText("Metadata completeness"), "missing_capture");
  expect(window.location.search).not.toContain("catalog_page");
  expect(window.location.search).toContain("catalog_tag=fox");
  expect(window.location.search).toContain("catalog_search=forest");
  await act(async () => window.history.back());
  await waitFor(() => expect((screen.getByLabelText("Metadata completeness") as HTMLSelectElement).value).toBe("missing_gps"));
  await act(async () => window.history.forward());
  await waitFor(() => expect((screen.getByLabelText("Metadata completeness") as HTMLSelectElement).value).toBe("missing_capture"));
  view.unmount();
  render(<FilterHarness />);
  expect((screen.getByLabelText("Metadata completeness") as HTMLSelectElement).value).toBe("missing_capture");
  await userEvent.selectOptions(screen.getByLabelText("Metadata completeness"), "");
  expect(window.location.search).not.toContain("catalog_metadata_issue");
  expect(window.location.search).toContain("catalog_tag=fox");
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  expect(window.location.search).toBe("");
});

test("List toolbar applies metadata criteria and visibly blocks Smart Collection saves and Map", async () => {
  window.history.replaceState(null, "", "/?catalog_metadata_issue=missing_gps&smart_edit=7");
  render(<Home />);
  await screen.findByText("No matching records");
  expect(screen.getByText(/Metadata completeness is a live List filter/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "View on Map" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText("Metadata completeness"), "missing_capture");
  await waitFor(() => expect(api.getCatalogPhotos).toHaveBeenLastCalledWith(expect.objectContaining({ metadata_issue: "missing_capture", page: 1 }), expect.any(AbortSignal)));
  await userEvent.selectOptions(screen.getByLabelText("Metadata completeness"), "");
  await waitFor(() => expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false));
});

test("unsupported navigation keeps metadata criteria available in List and Culling", async () => {
  const state = { ...DEFAULT_CATALOG_STATE, metadata_issue: "missing_gps" as const };
  const view = render(<ArchiveNavigation active="list" catalogState={state} />);
  await userEvent.click(screen.getByRole("link", { name: "Map" }));
  expect(screen.getByRole("alert").textContent).toContain("metadata completeness filters");
  expect(screen.getByRole("link", { name: "Open the filtered List" }).getAttribute("href")).toContain("catalog_metadata_issue=missing_gps");
  expect(screen.getByRole("link", { name: "Culling" }).getAttribute("href")).toContain("catalog_metadata_issue=missing_gps");
  view.unmount();
  window.history.replaceState(null, "", "/map?catalog_metadata_issue=missing_gps");
  render(<MapBrowser focusPhotoId={null} />);
  expect(screen.getByRole("alert").textContent).toContain("Metadata completeness filters are not supported on Map");
  expect(screen.getByRole("link", { name: "View in List" }).getAttribute("href")).toContain("catalog_metadata_issue=missing_gps");
  expect(api.getPhotoMapPoints).not.toHaveBeenCalled();
});

test("live filter roundtrips and rejects saved queries; API serializes it for List and Culling", async () => {
  for (const issue of Object.keys(metadataIssueLabels) as MetadataIssue[]) {
    const state = { ...DEFAULT_CATALOG_STATE, metadata_issue: issue };
    expect(parseCatalogState(writeCatalogState(new URLSearchParams(), state)).metadata_issue).toBe(issue);
    expect(mapListHref(state)).toContain(`catalog_metadata_issue=${issue}`);
    expect(() => savedQueryFromState(state, "")).toThrow(/Metadata completeness filters cannot be saved/);
  }
  expect(parseCatalogState(new URLSearchParams("catalog_metadata_issue=invalid")).metadata_issue).toBeUndefined();
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  // Use the actual module exports here because the List component mock is deliberate.
  const actual = await vi.importActual<typeof import("../app/lib/api")>("../app/lib/api");
  await actual.getCatalogPhotos({ ...DEFAULT_CATALOG_STATE, metadata_issue: "missing_gps" });
  await getCullingWorkspace({ ...DEFAULT_CATALOG_STATE, metadata_issue: "missing_capture" });
  expect(String(fetch.mock.calls[0][0])).toContain("metadata_issue=missing_gps");
  expect(String(fetch.mock.calls[1][0])).toContain("metadata_issue=missing_capture");
});
