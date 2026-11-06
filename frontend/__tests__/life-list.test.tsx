import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import LifeListBrowser from "../app/life-list/life-list-browser";
import type { LifeListFilters, LifeListPage, LifeListTaxon } from "../app/lib/api";

const api = vi.hoisted(() => ({ getLifeList: vi.fn() }));
vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()), ...api,
}));

const fox: LifeListTaxon = {
  taxon_id: 1, common_name: "Red fox", scientific_name: "Vulpes vulpes", taxonomic_rank: "SPECIES",
  first_observed_at: "2025-01-01T00:05:00", last_observed_at: "2026-06-01T09:00:00",
  sighting_count: 3, first_sighting_id: 12, last_sighting_id: 34,
  preview: { id: 1, thumbnail_filename: "fox-thumb.jpg", original_filename: "fox.jpg", display_title: "Fox in grass" },
};
const subspecies: LifeListTaxon = {
  ...fox, taxon_id: 2, common_name: null, scientific_name: "Vulpes vulpes vulpes",
  taxonomic_rank: "SUBSPECIES", first_sighting_id: 35, last_sighting_id: 35, sighting_count: 1, preview: null,
};

function result({ year, page = 1 }: Partial<LifeListFilters> = {}, overrides: Partial<LifeListPage> = {}): LifeListPage {
  return {
    items: [fox, subspecies], total: 2, page, page_size: 24, total_pages: 1,
    year: year ?? null, available_years: [2026, 2025],
    summary: { all_time_taxa: 2, all_time_sightings: 4, seen_taxa: year ? 2 : null, new_taxa: year ? 1 : null, scope_sightings: year ? 3 : 4 },
    ...overrides,
  };
}

beforeEach(() => {
  api.getLifeList.mockReset();
  window.history.replaceState(null, "", "/life-list");
});

test("renders yearly summaries, taxon cards, observation dates, and accessible sighting links", async () => {
  window.history.replaceState(null, "", "/life-list?year=2026");
  api.getLifeList.mockResolvedValue(result({ year: 2026 }));
  render(<LifeListBrowser />);
  expect(screen.getByRole("status").textContent).toBe("Loading Life List…");
  const list = await screen.findByRole("list", { name: "Verified taxa" });
  for (const [label, count] of [
    ["All-time verified taxa", "2"], ["Verified taxa seen in 2026", "2"],
    ["Verified taxa first recorded in 2026", "1"], ["Sightings in this view", "3"],
  ]) {
    expect(screen.getByText(label).nextElementSibling?.textContent).toBe(count);
  }
  const [first, second] = within(list).getAllByRole("article");
  expect(within(first).getByRole("heading", { name: "Red fox" })).toBeTruthy();
  expect(within(first).getByText("Vulpes vulpes", { exact: true })).toBeTruthy();
  expect(within(first).getByRole("img", { name: "Fox in grass" }).getAttribute("src")).toMatch(/\/thumbs\/fox-thumb\.jpg$/);
  expect(within(first).getByText("3 sightings")).toBeTruthy();
  expect(within(first).getByRole("link", { name: /First sighting.*Jan 1, 2025/ }).getAttribute("href")).toBe("/sightings/12");
  expect(within(first).getByRole("link", { name: /Latest sighting.*Jun 1, 2026/ }).getAttribute("href")).toBe("/sightings/34");
  expect(within(second).getByRole("heading", { name: "Vulpes vulpes vulpes" })).toBeTruthy();
  expect(within(second).getByText("Subspecies · 1 sighting")).toBeTruthy();
  expect(within(second).getByText("No active photos")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Life List" }).getAttribute("aria-current")).toBe("page");
});

test("filters and pages through accessible controls and restores every selection with browser history", async () => {
  const user = userEvent.setup();
  api.getLifeList.mockImplementation(async (filters: LifeListFilters) => result(filters, {
    items: [filters.page === 2 ? subspecies : fox], total: 25, total_pages: 2,
  }));
  render(<LifeListBrowser />);
  await screen.findByRole("heading", { name: "Red fox" });
  const year = screen.getByRole<HTMLSelectElement>("combobox", { name: "Observation year" });
  const mode = screen.getByRole<HTMLInputElement>("radio", { name: "First recorded this year" });
  const sort = screen.getByRole<HTMLSelectElement>("combobox", { name: "Sort taxa" });
  const searchBox = () => screen.getByRole<HTMLInputElement>("searchbox", { name: "Search names" });
  const lastRequest = (filters: LifeListFilters) => waitFor(() => {
    expect(api.getLifeList).toHaveBeenLastCalledWith(filters, expect.any(AbortSignal));
  });
  expect(mode.matches(":disabled")).toBe(true);
  await user.selectOptions(year, "2026");
  await lastRequest({ year: 2026, mode: "seen", search: "", sort: "name", page: 1 });
  await user.click(mode);
  await lastRequest({ year: 2026, mode: "new", search: "", sort: "name", page: 1 });
  await user.type(searchBox(), "Vulpes");
  await user.click(screen.getByRole("button", { name: "Search" }));
  await lastRequest({ year: 2026, mode: "new", search: "Vulpes", sort: "name", page: 1 });
  await user.selectOptions(sort, "most_observed");
  await lastRequest({ year: 2026, mode: "new", search: "Vulpes", sort: "most_observed", page: 1 });
  await user.click(await screen.findByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Vulpes vulpes vulpes" });
  expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  const pageTwo = "/life-list?year=2026&mode=new&search=Vulpes&sort=most_observed&page=2";
  expect(window.location.pathname + window.location.search).toBe(pageTwo);
  await user.selectOptions(year, "");
  await lastRequest({ year: undefined, mode: "seen", search: "Vulpes", sort: "most_observed", page: 1 });
  expect(window.location.search).toBe("?search=Vulpes&sort=most_observed");
  act(() => window.history.back());
  await screen.findByText("Page 2 of 2");
  expect(window.location.pathname + window.location.search).toBe(pageTwo);
  expect([year.value, mode.checked, searchBox().value, sort.value]).toEqual(["2026", true, "Vulpes", "most_observed"]);
  act(() => window.history.forward());
  await screen.findByText("Page 1 of 2");
  expect([year.value, mode.checked]).toEqual(["", false]);
});

test("shows failures and retries into an empty archive state", async () => {
  api.getLifeList.mockRejectedValueOnce(new Error("Could not load Life List"));
  api.getLifeList.mockResolvedValue(result({}, {
    items: [], total: 0, total_pages: 0, available_years: [],
    summary: { all_time_taxa: 0, all_time_sightings: 0, seen_taxa: null, new_taxa: null, scope_sightings: 0 },
  }));
  render(<LifeListBrowser />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Could not load Life List");
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "No verified taxa recorded yet" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open the Sightings Journal" }).getAttribute("href")).toBe("/sightings");
});

test("shows an empty result for a name search", async () => {
  window.history.replaceState(null, "", "/life-list?search=Ibis");
  api.getLifeList.mockResolvedValue(result({}, { items: [], total: 0, total_pages: 0 }));
  render(<LifeListBrowser />);
  expect(await screen.findByRole("heading", { name: "No matching verified taxa" })).toBeTruthy();
  expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Search names" }).value).toBe("Ibis");
});
