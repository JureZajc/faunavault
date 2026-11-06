import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getSightingMap, type SightingMapResult } from "../app/lib/api";
import { readSightingMapQuery, sightingDateError, sightingMapHref } from "../app/lib/sighting-map-query";
import SightingMapBrowser from "../app/sightings/map/sighting-map-browser";
import type { SightingMapProps } from "../app/components/maps/sighting-map.client";

vi.mock("../app/components/maps/map-boundaries", () => ({
  SightingMap: ({ points, focusId, onAreaSelect }: SightingMapProps) => <div role="region" aria-label="Test map" data-focus={focusId}>
    {points.map((point) => <span key={point.id}>{point.subject_label}</span>)}
    <button type="button" onClick={() => onAreaSelect({ bbox_south: 0, bbox_north: 1, bbox_west: 170, bbox_east: -170 })}>Search this map area</button>
  </div>,
}));

const empty: SightingMapResult = { points: [], total_matching: 0, without_location_count: 0, truncated: false };
const point = { id: 3, subject_label: "Fox crossing", latitude: 0, longitude: 0, location_label: null,
  taxon_id: 5, common_name: "Red fox", scientific_name: "Vulpes vulpes", thumbnail_filename: null, observed_at: "2026-08-23T23:58:00" };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/sightings/map");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("client serializes only map criteria, retains zero, and forwards cancellation", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(empty));
  const { signal } = new AbortController();
  const filters = { date_from: "2026-08-23", date_to: "", taxon_id: 5, focus: 3,
    bbox_south: 0, bbox_north: 1, bbox_west: 170, bbox_east: -170, sort: "oldest", page: 3 };
  const href = "/sightings/map?date_from=2026-08-23&taxon_id=5&bbox_south=0&bbox_north=1&bbox_west=170&bbox_east=-170&focus=3";
  expect(sightingMapHref(filters)).toBe(href);
  await expect(getSightingMap(filters, signal)).resolves.toEqual(empty);
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(href), expect.objectContaining({ signal, cache: "no-store" }));
  const parsed = readSightingMapQuery(new URLSearchParams(href.split("?")[1]));
  expect(parsed.error).toBeNull();
  expect(parsed.filters).toMatchObject({ date_from: "2026-08-23", bbox_south: 0, bbox_east: -170, focus: 3, taxon_id: 5 });
});

test("validates calendar dates, species IDs and complete geographic bounds", () => {
  expect(sightingDateError("2024-02-29", "2024-02-29")).toBeNull();
  expect(sightingDateError("0096-02-29")).toBeNull();
  expect(sightingDateError("2025-02-29")).toMatch(/valid observation dates/);
  expect(sightingDateError("0000-01-01")).toMatch(/valid observation dates/);
  expect(sightingDateError("2026-02-01", "2026-01-01")).toMatch(/on or before/);
  for (const taxon of ["0", "-3", "1.2", "NaN", "9007199254740992"]) {
    expect(readSightingMapQuery(new URLSearchParams(`taxon_id=${taxon}`)).error).toMatch(/valid local species/);
  }
  expect(readSightingMapQuery(new URLSearchParams("bbox_south=0")).error).toMatch(/all four/);
  expect(readSightingMapQuery(new URLSearchParams("focus=nope")).error).toMatch(/Invalid focused Sighting ID/);
});

test("shows loading, retries an error and explains an empty map with missing GPS", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ detail: "Archive unavailable" }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ ...empty, total_matching: 2, without_location_count: 2 }));
  render(<SightingMapBrowser />);
  expect(screen.getByText("Loading sightings…")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toContain("Archive unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "No matching sightings with GPS" })).toBeTruthy();
  expect(screen.getByText("2 without GPS")).toBeTruthy();
  expect(screen.getByText(/stay in the Journal/)).toBeTruthy();
});

test("applies date and area filters to the URL, clears focus, and restores filters with Back and Forward", async () => {
  window.history.replaceState(null, "", "/sightings/map?taxon_id=5&focus=3");
  fetchMock.mockImplementation(async () => Response.json({ ...empty, points: [point], total_matching: 1 }));
  render(<SightingMapBrowser />);
  await screen.findByText("Fox crossing");
  const map = screen.getByRole("region", { name: "Test map" });
  expect(map.getAttribute("data-focus")).toBe("3");
  fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-23" } });
  fireEvent.change(screen.getByLabelText("Through date"), { target: { value: "2026-08-22" } });
  expect((screen.getByRole("button", { name: "Apply dates" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Through date"), { target: { value: "2026-08-23" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply dates" }));
  expect(window.location.search).toBe("?date_from=2026-08-23&date_to=2026-08-23&taxon_id=5");
  expect(map.hasAttribute("data-focus")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Search this map area" }));
  expect(window.location.search).toContain("bbox_south=0&bbox_north=1&bbox_west=170&bbox_east=-170");
  expect(await screen.findByText("1 mapped encounter in this area")).toBeTruthy();
  window.history.back();
  await waitFor(() => expect(screen.queryByText(/mapped encounter in this area/)).toBeNull());
  await screen.findByText("1 mapped encounter");
  window.history.forward();
  await screen.findByText("1 mapped encounter in this area");
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(window.location.search).toBe("");
  expect((screen.getByLabelText("From date") as HTMLInputElement).value).toBe("");
});

test("reports truncation and an unavailable focus while retaining a detail link", async () => {
  window.history.replaceState(null, "", "/sightings/map?focus=77");
  fetchMock.mockResolvedValueOnce(Response.json({ points: [point], total_matching: 2224, without_location_count: 3, truncated: true }));
  expect(render(<SightingMapBrowser />)).toBeTruthy();
  expect(await screen.findByText("2221 mapped encounters")).toBeTruthy();
  expect(screen.getByText(/Showing 1 of 2221 mapped encounters/).textContent).toMatch(/zoom in and choose Search this map area/);
  expect(screen.getByRole("link", { name: "Check Sighting details" }).getAttribute("href")).toBe("/sightings/77");
});

test("invalid URL filters are visible and skip fetching until corrected", async () => {
  window.history.replaceState(null, "", "/sightings/map?taxon_id=-1");
  fetchMock.mockResolvedValueOnce(Response.json(empty));
  render(<SightingMapBrowser />);
  expect(screen.getByRole("alert").textContent).toMatch(/valid local species/);
  expect(fetchMock).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("heading", { name: "No matching sightings with GPS" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("aborts stale requests and ignores a response arriving after newer data", async () => {
  let completeOld!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { completeOld = resolve; }));
  fetchMock.mockResolvedValueOnce(Response.json({ ...empty, points: [point], total_matching: 1 }));
  render(<SightingMapBrowser />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const oldSignal = fetchMock.mock.calls[0][1]?.signal;
  fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-23" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply dates" }));
  await screen.findByText("Fox crossing");
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => completeOld(Response.json(empty)));
  expect(screen.getByText("Fox crossing")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "No matching sightings with GPS" })).toBeNull();
});
