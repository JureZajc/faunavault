import { afterEach, expect, test, vi } from "vitest";
import { updateCollectionCover } from "../app/lib/api";

afterEach(() => vi.unstubAllGlobals());

test("Collection cover selection and clearing use the focused JSON PATCH endpoint", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await updateCollectionCover(7, 11);
  await updateCollectionCover(7, null);
  expect(fetchMock.mock.calls.map(([url, options]) => [new URL(url).pathname, options.method, new Headers(options.headers).get("Content-Type"), JSON.parse(options.body)])).toEqual([
    ["/collections/7/cover", "PATCH", "application/json", { photo_id: 11 }],
    ["/collections/7/cover", "PATCH", "application/json", { photo_id: null }],
  ]);
});

test("Collection cover errors preserve the server's actionable message", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: { code: "photo_not_collection_member", message: "Cover must be a member Photo. Refresh the Collection." } }), { status: 409, headers: { "Content-Type": "application/json" } })));
  await expect(updateCollectionCover(7, 11)).rejects.toThrow("Cover must be a member Photo. Refresh the Collection.");
});
