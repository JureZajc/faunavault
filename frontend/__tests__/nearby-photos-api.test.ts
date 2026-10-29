import { afterEach, expect, test, vi } from "vitest";
import { getNearbyPhotos } from "../app/lib/api";

afterEach(() => vi.unstubAllGlobals());

test("requests lightweight nearby previews with default parameters and cancellation", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  await getNearbyPhotos(44, undefined, undefined, controller.signal);
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/photos/44/nearby?radius_km=5&limit=12"), expect.objectContaining({ signal: controller.signal, cache: "no-store" }));
  await getNearbyPhotos(55, 25, 24, controller.signal);
  expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining("/photos/55/nearby?radius_km=25&limit=24"), expect.objectContaining({ signal: controller.signal }));
});
