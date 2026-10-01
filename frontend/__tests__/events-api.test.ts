import { afterEach, expect, test, vi } from "vitest";
import { addEventPhotos, createEvent, removeEventPhotos, updateEvent } from "../app/lib/api";

afterEach(() => vi.unstubAllGlobals());

test("Event mutations send JSON objects with the correct content type and HTTP methods", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const metadata = { kind: "trip" as const, title: "Valencia", start_date: "2026-08-12", end_date: "2026-08-17", location_label: null, notes: "Line one\nLine two" };
  await createEvent(metadata);
  await updateEvent(7, { notes: null });
  await addEventPhotos(7, [11, 12]);
  await removeEventPhotos(7, [11]);
  expect(fetchMock.mock.calls.map(([url, options]) => [new URL(url).pathname, options.method, new Headers(options.headers).get("Content-Type"), JSON.parse(options.body)])).toEqual([
    ["/events", "POST", "application/json", metadata],
    ["/events/7", "PATCH", "application/json", { notes: null }],
    ["/events/7/photos", "POST", "application/json", { photo_ids: [11, 12] }],
    ["/events/7/photos", "DELETE", "application/json", { photo_ids: [11] }],
  ]);
});
