import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import NearbyPhotosSection from "../app/components/photo-detail/nearby-photos-section";
import { NearbyPhotosResponse, Photo } from "../app/lib/api";
import { formatNearbyDistance, nearbyPhotoHref, parseNearbyRadius } from "../app/lib/nearby-photos";

const api = vi.hoisted(() => ({ getNearbyPhotos: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...await original<typeof import("../app/lib/api")>(), ...api }));

const source = { id: 44, latitude: 0, longitude: 0, updated_at: "2026-01-01" } as Photo;
function result(overrides: Partial<NearbyPhotosResponse> = {}): NearbyPhotosResponse {
  return { source_photo_id: 44, radius_km: 5, availability: "available", unavailable_reason: null, total: 2, items: [
    { id: 45, original_filename: "fox.jpg", display_title: "Fox", thumbnail_filename: "fox-thumb.jpg", distance_m: 240, captured_at: "2026-05-24T23:50:00" },
    { id: 46, original_filename: "deer.jpg", display_title: " ", thumbnail_filename: "deer-thumb.jpg", distance_m: 1200, captured_at: null },
  ], ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/photos/44?returnTo=%2Fmap%3Fphoto%3D44");
  // Next patches native history updates to notify useSearchParams. Mirror that
  // framework behavior in jsdom; production never needs a synthetic popstate.
  const nativeReplace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, "replaceState").mockImplementation((...args) => {
    nativeReplace(...args);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  api.getNearbyPhotos.mockResolvedValue(result());
});
afterEach(() => vi.restoreAllMocks());

test("renders previews, titles, dates, distances, local source links and a responsive grid", async () => {
  render(<NearbyPhotosSection photo={source} />);
  expect(screen.getByRole("heading", { name: "Nearby Photos" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Loading");
  const link = await screen.findByRole("link", { name: /Fox/ });
  expect(link.getAttribute("href")).toBe("/photos/45?returnTo=%2Fphotos%2F44%3Fnearby_radius%3D5");
  expect(screen.getByRole("img", { name: "Fox" }).getAttribute("src")).toContain("/images/thumbs/fox-thumb.jpg");
  expect(screen.getByText("240 m away")).toBeTruthy();
  expect(screen.getByText("1.2 km away")).toBeTruthy();
  expect(screen.getByRole("link", { name: /deer.jpg/ })).toBeTruthy();
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2026-05-24T23:50:00");
  const grid = screen.getByRole("list", { name: "Nearby photos" });
  expect(grid.className).toContain("grid-cols-2");
  expect(grid.className).toContain("min-w-0");
  expect(api.getNearbyPhotos).toHaveBeenCalledExactlyOnceWith(44, 5, 12, expect.any(AbortSignal));
});

test.each([[null, null], [0, null], [null, 0], [91, 0], [0, -181], [NaN, 0], [0, Infinity]])("hides missing or invalid source GPS (%s, %s), without using extracted GPS", (latitude, longitude) => {
  render(<NearbyPhotosSection photo={{ ...source, latitude, longitude, extracted_latitude: 0, extracted_longitude: 0 }} />);
  expect(screen.queryByRole("heading")).toBeNull();
  expect(api.getNearbyPhotos).not.toHaveBeenCalled();
});

test("refreshes radius immediately, preserves returnTo and focus, and restores URL radius", async () => {
  window.history.replaceState(null, "", "/photos/44?returnTo=%2Fmap&nearby_radius=1");
  render(<NearbyPhotosSection photo={source} />);
  await screen.findByRole("link", { name: /Fox/ });
  const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Search radius" });
  expect(select.value).toBe("1");
  const firstSignal = api.getNearbyPhotos.mock.calls[0][3] as AbortSignal;
  await userEvent.selectOptions(select, "10");
  expect(api.getNearbyPhotos).toHaveBeenLastCalledWith(44, 10, 12, expect.any(AbortSignal));
  expect(firstSignal.aborted).toBe(true);
  expect(new URLSearchParams(window.location.search).get("returnTo")).toBe("/map");
  expect(new URLSearchParams(window.location.search).get("nearby_radius")).toBe("10");
  expect(document.activeElement).toBe(select);
  await act(async () => {
    window.history.replaceState(null, "", "/photos/44?nearby_radius=25");
  });
  expect(select.value).toBe("25");
  expect(api.getNearbyPhotos).toHaveBeenLastCalledWith(44, 25, 12, expect.any(AbortSignal));
});

test("announces empty results and explicit unavailable responses", async () => {
  api.getNearbyPhotos.mockResolvedValueOnce(result({ total: 0, items: [] }));
  render(<NearbyPhotosSection photo={source} />);
  await screen.findByText(/No other photos found within 5 km/);
  expect(screen.queryByRole("list")).toBeNull();
  api.getNearbyPhotos.mockResolvedValueOnce(result({ availability: "unavailable", total: 0, items: [] }));
  await userEvent.selectOptions(screen.getByLabelText("Search radius"), "1");
  await screen.findByText(/no valid GPS location/);
});

test("offers retry after an error, with a clear loading state", async () => {
  const pending = deferred<NearbyPhotosResponse>();
  api.getNearbyPhotos.mockRejectedValueOnce(new Error("offline")).mockReturnValueOnce(pending.promise);
  render(<NearbyPhotosSection photo={source} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load");
  await userEvent.click(screen.getByRole("button", { name: "Retry nearby photos" }));
  expect(screen.getByRole("status").textContent).toContain("Loading");
  await act(async () => pending.resolve(result()));
  await screen.findByRole("link", { name: /Fox/ });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("rapid switching aborts obsolete requests and ignores stale success and error responses", async () => {
  const first = deferred<NearbyPhotosResponse>();
  const second = deferred<NearbyPhotosResponse>();
  const third = deferred<NearbyPhotosResponse>();
  api.getNearbyPhotos.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
  render(<NearbyPhotosSection photo={source} />);
  fireEvent.change(screen.getByLabelText("Search radius"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Search radius"), { target: { value: "25" } });
  expect(api.getNearbyPhotos.mock.calls.map((call) => call[1])).toEqual([5, 1, 25]);
  expect(api.getNearbyPhotos.mock.calls[0][3].aborted).toBe(true);
  expect(api.getNearbyPhotos.mock.calls[1][3].aborted).toBe(true);
  await act(async () => third.resolve(result({ radius_km: 25, total: 0, items: [] })));
  await screen.findByText(/No other photos found within 25 km/);
  await act(async () => { first.resolve(result()); second.reject(new Error("late")); });
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText(/No other photos found within 25 km/)).toBeTruthy();
});

test("changing Photo identity or effective GPS aborts requests, clearing GPS removes the section", async () => {
  const pending = deferred<NearbyPhotosResponse>();
  api.getNearbyPhotos.mockReturnValue(pending.promise);
  const view = render(<NearbyPhotosSection photo={source} />);
  const signal = api.getNearbyPhotos.mock.calls[0][3] as AbortSignal;
  view.rerender(<NearbyPhotosSection photo={{ ...source, latitude: -46 }} />);
  expect(signal.aborted).toBe(true);
  const nextSignal = api.getNearbyPhotos.mock.calls[1][3] as AbortSignal;
  view.rerender(<NearbyPhotosSection photo={{ ...source, id: 55 }} />);
  expect(nextSignal.aborted).toBe(true);
  expect(api.getNearbyPhotos).toHaveBeenLastCalledWith(55, 5, 12, expect.any(AbortSignal));
  const lastSignal = api.getNearbyPhotos.mock.calls[2][3] as AbortSignal;
  view.rerender(<NearbyPhotosSection photo={{ ...source, latitude: null, longitude: null }} />);
  expect(lastSignal.aborted).toBe(true);
  await act(async () => pending.resolve(result()));
  expect(screen.queryByRole("heading")).toBeNull();
});

test("returning to a previous radius starts a fresh loading state", async () => {
  const pending = deferred<NearbyPhotosResponse>();
  api.getNearbyPhotos.mockResolvedValueOnce(result()).mockReturnValue(pending.promise);
  render(<NearbyPhotosSection photo={source} />);
  await screen.findByRole("link", { name: /Fox/ });
  fireEvent.change(screen.getByLabelText("Search radius"), { target: { value: "1" } });
  fireEvent.change(screen.getByLabelText("Search radius"), { target: { value: "5" } });
  expect(screen.getByRole("status").textContent).toContain("Loading");
  expect(screen.queryByRole("link")).toBeNull();
  await act(async () => pending.resolve(result({ total: 0, items: [] })));
  await screen.findByText(/No other photos found within 5 km/);
});

test("native radius control and thumbnail links are keyboard accessible", async () => {
  render(<NearbyPhotosSection photo={source} />);
  const link = await screen.findByRole("link", { name: /Fox/ });
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Search radius" }));
  await userEvent.tab();
  expect(document.activeElement).toBe(link);
});

test.each([[0, "0 m"], [240.24, "240 m"], [999.9, "999 m"], [1000, "1 km"], [1234, "1.2 km"], [25000, "25 km"]])("formats %s meters as %s", (distance, expected) => {
  expect(formatNearbyDistance(distance)).toBe(expected);
});

test("bounds local source links to one return hop and accepts only supported radii", () => {
  const link = new URL(nearbyPhotoHref(45, 44, 10), "http://localhost");
  const back = new URL(link.searchParams.get("returnTo")!, "http://localhost");
  expect(back.pathname).toBe("/photos/44");
  expect(back.searchParams.get("nearby_radius")).toBe("10");
  expect(back.searchParams.has("returnTo")).toBe(false);
  expect(parseNearbyRadius("2")).toBe(5);
  expect(parseNearbyRadius("Infinity")).toBe(5);
  expect(parseNearbyRadius(null)).toBe(5);
});
