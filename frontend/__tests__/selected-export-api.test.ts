import { afterEach, expect, test, vi } from "vitest";
import { API_BASE_URL, downloadSelectedExport, estimateSelectedExport, prepareSelectedExport } from "../app/lib/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("native download uses validated API link and no JavaScript Blob", () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.href).toBe(`${API_BASE_URL}/exports/selected/token_123`);
    expect(this.download).toBe("FaunaVault-Export.zip");
    expect(this.referrerPolicy).toBe("no-referrer");
    expect(this.isConnected).toBe(true);
  });
  downloadSelectedExport("/exports/selected/token_123");
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector("a")).toBeNull();
  for (const path of ["https://evil.example/file", "//evil.example", "/exports/selected/../../secret", "/exports/selected/x?redirect=evil"]) {
    expect(() => downloadSelectedExport(path)).toThrow("Invalid export download link");
  }
});

test("export APIs send only explicit IDs and configuration", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetch);
  const body = { photo_ids: [1, 5], mode: "originals" as const, include_metadata: true };
  await estimateSelectedExport(body);
  await prepareSelectedExport(body);
  expect(fetch.mock.calls.map((call) => call[0])).toEqual([`${API_BASE_URL}/exports/selected/estimate`, `${API_BASE_URL}/exports/selected`]);
  for (const call of fetch.mock.calls) expect(JSON.parse(call[1].body)).toEqual(body);
});
