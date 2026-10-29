import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import InsightsBrowser from "../app/insights/insights-browser";
import { InsightsResponse } from "../app/lib/api";
import { insightsDifference, insightsListHref, parseComparisonYear, parseInsightsYear } from "../app/lib/insights";

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
    equipment: {
      camera: { known: total ? 8 : 0, missing: total ? 2 : 0, percentage: total ? 80 : 0 },
      lens: { known: total ? 7 : 0, missing: total ? 3 : 0, percentage: total ? 70 : 0 },
      top_cameras: total ? [
        { camera_make: "Canon", camera_model: "R5", photo_count: 5, percentage: 50 },
        { camera_make: "Canon", camera_model: null, photo_count: 2, percentage: 20 },
        { camera_make: null, camera_model: "R5", photo_count: 1, percentage: 10 },
      ] : [],
      top_lenses: total ? [{ lens_model: "RF100", photo_count: 7, percentage: 70 }] : [],
    },
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

test("equipment charts have scoped exact and unknown links, counts and coverage", async () => {
  window.history.replaceState(null, "", "/insights?year=2026");
  api.getInsights.mockResolvedValue(insights(2026));
  render(<InsightsBrowser />);
  const cameras = await screen.findByRole("region", { name: "Top Cameras" });
  expect(within(cameras).getByRole("list")).toBeTruthy();
  expect(cameras.textContent).toContain("5 photos50%");
  const links = within(cameras).getAllByRole("link");
  for (const [index, make, model] of [[0, "Canon", "R5"], [1, "Canon", ""], [2, "", "R5"]] as const) {
    const params = new URL(links[index].getAttribute("href")!, "http://localhost").searchParams;
    expect(params.get("catalog_camera_make")).toBe(make);
    expect(params.get("catalog_camera_model")).toBe(model);
    expect(params.get("catalog_taken_from")).toBe("2026-01-01");
    expect(params.get("catalog_taken_to")).toBe("2026-12-31");
  }
  expect(screen.getByRole("link", { name: /RF100/ }).getAttribute("href")).toContain("catalog_lens_model=RF100");
  const coverage = screen.getByRole("region", { name: "Equipment coverage" });
  expect(coverage.textContent).toContain("8 photos · 80%");
  expect(coverage.textContent).toContain("3 photos · 30%");
  expect(screen.getByRole("link", { name: "Without identifiable camera information" }).getAttribute("href")).toContain("catalog_unknown_camera=1&catalog_taken_from=2026-01-01");
  expect(screen.getByRole("link", { name: "Without lens information" }).getAttribute("href")).toContain("catalog_unknown_lens=1&catalog_taken_from=2026-01-01");
});

test("comparison is explicit, persists in URL, restores history and clears identical or All Time selections", async () => {
  api.getInsights.mockImplementation((year?: number) => Promise.resolve(insights(year ?? null, year === 2025 ? 5 : 10)));
  render(<InsightsBrowser />);
  await screen.findByRole("region", { name: "Top Cameras" });
  expect((screen.getByLabelText("Compare with") as HTMLSelectElement).disabled).toBe(true);
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2026");
  await screen.findByRole("link", { name: /February/ });
  expect(screen.queryByRole("region", { name: "Year comparison" })).toBeNull();
  expect((screen.getByLabelText("Compare with") as HTMLSelectElement).value).toBe("");
  await userEvent.selectOptions(screen.getByLabelText("Compare with"), "2025");
  const comparison = await screen.findByRole("region", { name: "Year comparison" });
  await within(comparison).findByRole("link", { name: "Browse 2025 photos" });
  expect(window.location.search).toBe("?year=2026&compare=2025");
  expect(comparison.textContent).toContain("Difference: +5 (+100%)");
  expect(api.getInsights.mock.calls.filter(([year]) => year === 2026)).toHaveLength(1);
  act(() => {
    window.history.replaceState(null, "", "/insights?year=2025&compare=2026");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await screen.findByRole("link", { name: "Browse 2026 photos" });
  expect((screen.getByLabelText("Compare with") as HTMLSelectElement).value).toBe("2026");
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2026");
  expect(window.location.search).toBe("?year=2026");
  expect(screen.queryByRole("region", { name: "Year comparison" })).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText("Compare with"), "2025");
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "");
  expect(window.location.search).toBe("");
  expect(screen.queryByRole("region", { name: "Year comparison" })).toBeNull();
});

test.each(["/insights?compare=2025", "/insights?year=2026&compare=2026", "/insights?year=2026&compare=oops", "/insights?year=2026&compare=10000"])("invalid comparison %s never fetches a second period", async (url) => {
  window.history.replaceState(null, "", url);
  api.getInsights.mockImplementation((year?: number) => Promise.resolve(insights(year ?? null)));
  render(<InsightsBrowser />);
  await screen.findByRole("region", { name: "Top Cameras" });
  expect(screen.getByText(/Comparison requires two different valid capture years/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Year comparison" })).toBeNull();
  expect(api.getInsights).toHaveBeenCalledTimes(1);
});

test("comparison reload handles zero baselines and GPS percentage points", async () => {
  window.history.replaceState(null, "", "/insights?year=2026&compare=2025");
  const baseline = insights(2025, 0);
  baseline.overview.gps = { known: 0, missing: 0, percentage: 0 };
  api.getInsights.mockImplementation((year?: number) => Promise.resolve(year === 2025 ? baseline : insights(2026)));
  render(<InsightsBrowser />);
  await screen.findByRole("link", { name: "Browse 2025 photos" });
  const comparison = screen.getByRole("region", { name: "Year comparison" });
  expect(comparison.textContent).toContain("2026: 10");
  expect(comparison.textContent).toContain("2025: 0");
  expect(comparison.textContent).toContain("Difference: +10 (N/A — zero baseline)");
  expect(comparison.textContent).toContain("Difference: +40 percentage points");
  expect(comparison.textContent).not.toMatch(/Infinity|NaN/);
  expect(within(comparison).getByRole("link", { name: "Browse 2025 photos" }).getAttribute("href")).toContain("catalog_taken_to=2025-12-31");
  expect(screen.getByText(/No active photos in comparison year 2025/)).toBeTruthy();
});

test("comparison failure retries independently and cancelled comparisons cannot reappear", async () => {
  window.history.replaceState(null, "", "/insights?year=2026&compare=2025");
  let resolveOld!: (value: InsightsResponse) => void;
  let attempt = 0;
  api.getInsights.mockImplementation((year?: number) => {
    if (year === 2026) return Promise.resolve(insights(2026));
    if (++attempt === 1) return Promise.reject(new Error("private path"));
    return new Promise((resolve) => { resolveOld = resolve; });
  });
  render(<InsightsBrowser />);
  await screen.findByText("Could not load year comparison");
  expect(screen.getByRole("region", { name: "Top Cameras" })).toBeTruthy();
  const retry = screen.getByRole("button", { name: "Retry comparison" });
  retry.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Loading year comparison…");
  const signal = api.getInsights.mock.calls.at(-1)![1] as AbortSignal;
  await userEvent.selectOptions(screen.getByLabelText("Compare with"), "");
  expect(signal.aborted).toBe(true);
  await act(async () => resolveOld(insights(2025, 999)));
  expect(screen.queryByRole("region", { name: "Year comparison" })).toBeNull();
  expect(api.getInsights.mock.calls.filter(([year]) => year === 2026)).toHaveLength(1);
});

test("comparison differences have signed counts, zero guards and percentage points", () => {
  expect(insightsDifference(5, 10)).toBe("-5 (-50%)");
  expect(insightsDifference(0, 0)).toBe("0 (N/A — zero baseline)");
  expect(insightsDifference(33.33, 66.67, true)).toBe("-33.34 percentage points");
  expect(parseComparisonYear("2025", 2026)).toBe(2025);
  expect(parseComparisonYear("2025")).toBeUndefined();
});

test("comparison retries successfully and late responses cannot replace a different comparison year", async () => {
  window.history.replaceState(null, "", "/insights?year=2026&compare=2025");
  const primary = insights(2026);
  primary.available_years.push(2024);
  let resolveOld!: (value: InsightsResponse) => void;
  let attempts = 0;
  api.getInsights.mockImplementation((year?: number) => {
    if (year === 2026) return Promise.resolve(primary);
    if (year === 2024) return new Promise((resolve) => { resolveOld = resolve; });
    return ++attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(insights(2025, 5));
  });
  render(<InsightsBrowser />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry comparison" }));
  await screen.findByRole("link", { name: "Browse 2025 photos" });
  await userEvent.selectOptions(screen.getByLabelText("Compare with"), "2024");
  await screen.findByText("Loading year comparison…");
  expect(screen.queryByRole("link", { name: "Browse 2025 photos" })).toBeNull();
  const signal = api.getInsights.mock.calls.at(-1)![1] as AbortSignal;
  await userEvent.selectOptions(screen.getByLabelText("Compare with"), "2025");
  await screen.findByRole("link", { name: "Browse 2025 photos" });
  expect(signal.aborted).toBe(true);
  await act(async () => resolveOld(insights(2024, 999)));
  expect(screen.getByRole("region", { name: "Year comparison" }).textContent).toContain("Difference: +5 (+100%)");
  expect(screen.queryByText(/999/)).toBeNull();
  expect(api.getInsights.mock.calls.filter(([year]) => year === 2026)).toHaveLength(1);
});
