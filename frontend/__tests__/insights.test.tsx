import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import InsightsBrowser from "../app/insights/insights-browser";
import { InsightsResponse } from "../app/lib/api";
import { insightsListHref, parseInsightsYear } from "../app/lib/insights";

const api = vi.hoisted(() => ({ getInsights: vi.fn() }));
vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()), ...api,
}));

function insights(year: number | null = null, total = 10): InsightsResponse {
  return {
    year, available_years: [2025, 2026],
    overview: {
      total_photos: total, verified_species: total ? 1 : 0, favorites: 2, picks: 3, rejects: 1,
      unverified_photos: 2, other_taxon_rank_photos: 1,
      gps: { known: 4, missing: 6, percentage: 40 },
      capture_dates: { known: year ? total : 8, missing: year ? 0 : 2, percentage: year ? 100 : 80 },
    },
    monthly: year ? Array.from({ length: 12 }, (_, index) => ({ period: index + 1, photo_count: index === 1 ? total : 0 })) : [],
    yearly: year ? [{ period: year, photo_count: total }] : [{ period: 2025, photo_count: 3 }, { period: 2026, photo_count: 5 }],
    top_species: total ? [{ taxon_id: 12, common_name: "Red fox", scientific_name: "Vulpes vulpes", photo_count: 7, percentage: 70 }] : [],
    categories: [{ value: "mammal", label: "mammal", photo_count: 7, percentage: 70, other: false }, { value: null, label: "Uncategorized", photo_count: 3, percentage: 30, other: false }],
    classification: [{ value: "pending", label: "Pending", photo_count: 2, percentage: 20, other: false }, { value: "classified", label: "Classified", photo_count: 7, percentage: 70, other: false }, { value: "needs_review", label: "Needs Review", photo_count: 1, percentage: 10, other: false }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/insights");
});

test("renders summary definitions, accessible bars and isolated drill-down links", async () => {
  api.getInsights.mockResolvedValue(insights());
  render(<InsightsBrowser />);
  expect(screen.getByRole("status").textContent).toContain("Loading Wildlife Insights");
  const summary = await screen.findAllByRole("definition");
  // Values are readable semantic definition lists and chart lists, without SVG-only labels.
  expect(summary).toBeTruthy();
  const metrics = summary[0].closest("dl")!;
  expect(metrics.textContent).toContain("Active photos10");
  expect(metrics.textContent).toContain("Distinct linked taxa at species rank");
  expect(metrics.textContent).toContain("40% of active photos");
  const species = screen.getByRole("region", { name: "Top Species" });
  expect(within(species).getByRole("list")).toBeTruthy();
  expect(species.textContent).toContain("7 photos70%");
  expect(screen.getByRole("link", { name: /Red fox/ }).getAttribute("href")).toBe("/?catalog_taxon=12");
  expect(screen.getByRole("link", { name: /Uncategorized/ }).getAttribute("href")).toBe("/?catalog_uncategorized=1");
  expect(screen.getByRole("link", { name: /^Pending/ }).getAttribute("href")).toBe("/?catalog_status=pending");
  expect(screen.getByRole("link", { name: /^mammal/ }).getAttribute("href")).toBe("/?catalog_category=mammal");
  expect(screen.getByRole("link", { name: /^2025/ }).getAttribute("href")).toContain("catalog_taken_from=2025-01-01");
  expect(screen.getByRole("link", { name: "View on Map" }).getAttribute("href")).toBe("/map");
  expect(screen.getByText(/2 photos without linked verified taxonomy/)).toBeTruthy();
  expect(screen.getByText(/2 photos without capture dates in this period/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Insights" }).getAttribute("aria-current")).toBe("page");
});

test("restores year from URL and keeps drill-down periods consistent", async () => {
  window.history.replaceState(null, "", "/insights?year=2026&catalog_search=stale");
  api.getInsights.mockImplementation((year?: number) => Promise.resolve(insights(year ?? null)));
  render(<InsightsBrowser />);
  await screen.findByRole("link", { name: /February/ });
  expect(api.getInsights).toHaveBeenCalledWith(2026, expect.any(AbortSignal));
  expect((screen.getByLabelText("Capture year") as HTMLSelectElement).value).toBe("2026");
  expect(screen.getByRole("link", { name: /February/ }).getAttribute("href")).toContain("catalog_taken_to=2026-02-28");
  expect(screen.getByRole("link", { name: /January/ }).textContent).toContain("0 photos");
  expect(screen.getByRole("link", { name: /Red fox/ }).getAttribute("href")).toContain("catalog_taxon=12&catalog_taken_from=2026-01-01&catalog_taken_to=2026-12-31");
  expect(screen.getByRole("link", { name: "View on Map" }).getAttribute("href")).toContain("catalog_taken_from=2026-01-01");
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2025");
  await waitFor(() => expect(api.getInsights).toHaveBeenLastCalledWith(2025, expect.any(AbortSignal)));
  expect(window.location.search).toContain("year=2025");
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "");
  await waitFor(() => expect(api.getInsights).toHaveBeenLastCalledWith(undefined, expect.any(AbortSignal)));
  expect(window.location.search).not.toContain("year=");
  // Restoring history is reflected in both selector and request.
  act(() => {
    window.history.replaceState(null, "", "/insights?year=2026");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(api.getInsights).toHaveBeenLastCalledWith(2026, expect.any(AbortSignal)));
});

test("empty archives, undated-only photos and scientific-name fallback", async () => {
  const empty = insights(null, 0);
  empty.yearly = [];
  api.getInsights.mockResolvedValueOnce(empty);
  const first = render(<InsightsBrowser />);
  expect(await screen.findByText("No active photos yet")).toBeTruthy();
  expect(screen.getByText("No verified species in this period.")).toBeTruthy();
  expect(screen.getByText("No photos with capture dates yet.")).toBeTruthy();
  first.unmount();
  const undated = insights();
  undated.yearly = [];
  undated.overview.capture_dates = { known: 0, missing: 10, percentage: 0 };
  undated.top_species[0].common_name = null;
  api.getInsights.mockResolvedValueOnce(undated);
  render(<InsightsBrowser />);
  expect(await screen.findByText(/10 photos without capture dates/)).toBeTruthy();
  expect(screen.getByRole("link", { name: /Vulpes vulpes/ })).toBeTruthy();
});

test("API failure exposes a safe error and keyboard-accessible retry", async () => {
  api.getInsights.mockRejectedValueOnce(new Error("private database path")).mockResolvedValueOnce(insights());
  render(<InsightsBrowser />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Could not load Wildlife Insights"));
  expect(screen.queryByText("private database path")).toBeNull();
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Retry" }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("link", { name: /Red fox/ })).toBeTruthy();
  expect(api.getInsights).toHaveBeenCalledTimes(2);
});

test("late responses cannot replace a newly selected period and requests abort on unmount", async () => {
  let resolveOld!: (value: InsightsResponse) => void;
  api.getInsights.mockResolvedValueOnce(insights()).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(insights(2025, 25));
  const view = render(<InsightsBrowser />);
  await screen.findByRole("link", { name: /Red fox/ });
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2026");
  await waitFor(() => expect(api.getInsights).toHaveBeenCalledTimes(2));
  const oldSignal = api.getInsights.mock.calls[1][1] as AbortSignal;
  expect(screen.getByRole("status").textContent).toContain("Loading");
  // The year options remain usable during loading.
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2025");
  await screen.findByRole("link", { name: /February/ });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolveOld(insights(2026, 999)));
  expect(screen.queryByText("999")).toBeNull();
  expect((screen.getByLabelText("Capture year") as HTMLSelectElement).value).toBe("2025");
  const lastSignal = api.getInsights.mock.calls[2][1] as AbortSignal;
  view.unmount();
  expect(lastSignal.aborted).toBe(true);
});

test("validates year and creates exact period URLs without timezone shifts", () => {
  for (const input of ["0", "10000", "x", "2026.5", "-1", ""]) expect(parseInsightsYear(input)).toBeUndefined();
  expect(parseInsightsYear("0001")).toBe(1);
  expect(parseInsightsYear("9999")).toBe(9999);
  expect(insightsListHref(1)).toBe("/?catalog_taken_from=0001-01-01&catalog_taken_to=0001-12-31");
});

test("invalid URL year and unknown valid years have explicit states", async () => {
  window.history.replaceState(null, "", "/insights?year=oops");
  api.getInsights.mockResolvedValueOnce(insights());
  const view = render(<InsightsBrowser />);
  expect(screen.getByText("Invalid year in URL. Showing All Time.")).toBeTruthy();
  await screen.findByRole("link", { name: /Red fox/ });
  view.unmount();
  window.history.replaceState(null, "", "/insights?year=1999");
  api.getInsights.mockResolvedValueOnce(insights(1999, 0));
  render(<InsightsBrowser />);
  expect(await screen.findByText("No active photos in this year")).toBeTruthy();
  expect((screen.getByLabelText("Capture year") as HTMLSelectElement).value).toBe("1999");
});
