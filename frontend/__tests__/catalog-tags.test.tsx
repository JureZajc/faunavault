import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import TagsBrowser from "../app/tags/tags-browser";
import CatalogTagFilter from "../app/components/catalog/catalog-tag-filter";
import ArchiveNavigation from "../app/components/archive-navigation";
import BulkActionDialog from "../app/components/catalog/bulk-action-dialog";
import { useCatalogQueryState } from "../app/hooks/use-catalog-query-state";
import { DEFAULT_CATALOG_STATE, mapListHref, parseCatalogState, tagListHref, writeCatalogState } from "../app/lib/catalog-query";
import { getCatalogPhotos, getCullingWorkspace } from "../app/lib/api";
import { savedQueryFromState } from "../app/lib/smart-collections";

const api = vi.hoisted(() => ({ getCatalogTags: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
  api.getCatalogTags.mockResolvedValue({ tags: [{ name: "birds", count: 3 }, { name: "sunset", count: 5 }, { name: "bird", count: 1 }], total_tags: 3, untagged_count: 2 });
});

test("Explorer loads, searches, sorts, and links to exact tag or untagged List", async () => {
  render(<TagsBrowser />);
  expect(screen.getByText("Loading tags…")).toBeTruthy();
  const region = screen.getByRole("region", { name: "Tags" });
  await within(region).findByRole("link", { name: "birds 3 photos" });
  expect(screen.getByText(/3 distinct tags/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "2 photos without tags" }).getAttribute("href")).toBe("/?catalog_untagged=1");
  expect(within(region).getAllByRole("link").map((link) => link.textContent)).toEqual(["bird1 photo", "birds3 photos", "sunset5 photos"]);
  await userEvent.selectOptions(screen.getByLabelText("Sort tags"), "count");
  expect(within(region).getAllByRole("link")[0].textContent).toBe("sunset5 photos");
  await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "birds");
  const link = within(region).getByRole("link", { name: "birds 3 photos" });
  expect(link.getAttribute("href")).toBe("/?catalog_tag=birds");
  link.focus();
  expect(document.activeElement).toBe(link);
  await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "missing");
  expect(screen.getByText("No tags match your search.")).toBeTruthy();
});

test("Explorer empty and error states can retry", async () => {
  api.getCatalogTags.mockRejectedValueOnce(new Error("Tag service unavailable"));
  api.getCatalogTags.mockResolvedValue({ tags: [], total_tags: 0, untagged_count: 0 });
  render(<TagsBrowser />);
  await screen.findByText("Tag service unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Retry tags" }));
  await screen.findByText(/No tags yet/);
});

function FilterHarness() {
  const query = useCatalogQueryState();
  return <><CatalogTagFilter tags={query.catalogState.tags} untagged={query.catalogState.untagged} onChange={query.setTagFilters} /><button type="button" onClick={() => { query.setTagFilters([]); query.setSearchInput("fox"); }}>Clear tags and search</button><output>{JSON.stringify(query.catalogState)}</output></>;
}

test("an immediately queued search cannot restore a just-cleared tag criterion", async () => {
  window.history.replaceState(null, "", "/?catalog_untagged=1");
  render(<FilterHarness />);
  await userEvent.click(screen.getByRole("button", { name: "Clear tags and search" }));
  await waitFor(() => expect(window.location.search).toContain("catalog_search=fox"));
  expect(window.location.search).not.toContain("catalog_untagged");
});

test("chips add AND tags, remove individually, clear, restore history, and reset pages while preserving other criteria", async () => {
  window.history.replaceState(null, "", "/?catalog_tag=birds&catalog_page=3&catalog_search=fox&catalog_rating=4&catalog_category=bird");
  render(<FilterHarness />);
  expect(screen.getByRole("button", { name: "Remove tag birds" })).toBeTruthy();
  await userEvent.click(screen.getByRole("searchbox", { name: "Search tag options" }));
  await screen.findByRole("option", { name: "sunset (5)" });
  await userEvent.selectOptions(screen.getByLabelText("Add exact tag"), "sunset");
  expect(new URLSearchParams(window.location.search).getAll("catalog_tag")).toEqual(["birds", "sunset"]);
  expect(window.location.search).not.toContain("catalog_page");
  expect(window.location.search).toContain("catalog_search=fox");
  expect(window.location.search).toContain("catalog_rating=4");
  expect(window.location.search).toContain("catalog_category=bird");
  await userEvent.click(screen.getByRole("button", { name: "Remove tag birds" }));
  expect(screen.queryByRole("button", { name: "Remove tag birds" })).toBeNull();
  await act(async () => window.history.back());
  await screen.findByRole("button", { name: "Remove tag birds" });
  await act(async () => window.history.forward());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove tag birds" })).toBeNull());
  await userEvent.click(screen.getByLabelText("Photos without tags"));
  expect(window.location.search).toContain("catalog_untagged=1");
  expect(new URLSearchParams(window.location.search).getAll("catalog_tag")).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "Clear tag filters" }));
  expect(window.location.search).not.toContain("catalog_untagged");
});

test("URL helpers preserve tags, case, reserved characters and unsupported Smart criteria throw", () => {
  const state = { ...DEFAULT_CATALOG_STATE, tags: ["Bird & sky", "birds"], search: "forest", untagged: false };
  expect(parseCatalogState(writeCatalogState(new URLSearchParams(), state)).tags).toEqual(state.tags);
  expect(mapListHref(state)).toContain("catalog_tag=Bird+%26+sky");
  expect(tagListHref("Bird & sky")).toBe("/?catalog_tag=Bird+%26+sky");
  expect(parseCatalogState(new URLSearchParams("catalog_tag=%EF%BB%BFbirds&catalog_tag=%C2%85birds%C2%85")).tags).toEqual(["\uFEFFbirds", "birds"]);
  expect(() => savedQueryFromState(state, "forest")).toThrow(/Clear the tag filters/);
  expect(() => savedQueryFromState({ ...DEFAULT_CATALOG_STATE, untagged: true }, "")).toThrow(/live catalog filters/);
});

test("navigation explains unsupported views and retains tag criteria in List and Culling links", async () => {
  render(<ArchiveNavigation active="list" catalogState={{ ...DEFAULT_CATALOG_STATE, tags: ["birds"] }} />);
  expect(screen.getByRole("link", { name: "List" }).getAttribute("href")).toContain("catalog_tag=birds");
  expect(screen.getByRole("link", { name: "Culling" }).getAttribute("href")).toContain("catalog_tag=birds");
  await userEvent.click(screen.getByRole("link", { name: "Map" }));
  expect(screen.getByRole("alert").textContent).toContain("does not apply the current exact tag filters");
  expect(screen.getByRole("link", { name: "Open the filtered List" }).getAttribute("href")).toContain("catalog_tag=birds");
});

test("List and Culling API serialize repeated exact tags and untagged", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  await getCatalogPhotos({ ...DEFAULT_CATALOG_STATE, tags: ["bird", "sunset"] });
  expect(String(fetch.mock.calls[0][0])).toContain("tags=bird&tags=sunset");
  await getCullingWorkspace({ ...DEFAULT_CATALOG_STATE, untagged: true });
  expect(String(fetch.mock.calls[1][0])).toContain("untagged=true");
});

test("bulk suggestions fill the dialog and only submit after explicit confirmation", async () => {
  const submit = vi.fn().mockResolvedValue(true);
  render(<BulkActionDialog action="add_tags" selectedCount={2} categoryOptions={[]} isBusy={false} error={null} onClose={vi.fn()} onSubmit={submit} />);
  await screen.findByRole("option", { name: "birds (3)" });
  await userEvent.selectOptions(screen.getByLabelText("Suggest an existing tag"), "birds");
  expect((screen.getByLabelText("Tags, separated by commas") as HTMLInputElement).value).toBe("birds");
  expect(submit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Add tags" }));
  expect(submit).toHaveBeenCalledWith({ operation: "add_tags", tags: ["birds"] });
});
