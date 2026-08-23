import { afterEach, describe, expect, test, vi } from "vitest";

import { uploadPhoto, uploadPhotoBatch } from "../app/lib/api";

function successfulResponse() {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function submittedFormData(fetchMock: ReturnType<typeof vi.fn>, call = 0) {
  return fetchMock.mock.calls[call][1]?.body as FormData;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HEIC/HEIF multipart media types", () => {
  test.each([
    ["IMG_2757.HEIC", "image/heif", "image/heic"],
    ["IMG_2758.heic", "", "image/heic"],
    ["archive.HEIF", "image/heic", "image/heif"],
  ])(
    "normalizes %s from %s to %s without changing its bytes",
    async (name, browserType, expectedType) => {
      const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
      vi.stubGlobal("fetch", fetchMock);
      const source = new File([new Uint8Array([0, 1, 2, 255])], name, {
        type: browserType,
        lastModified: 1234,
      });

      await uploadPhoto(source);

      const submitted = submittedFormData(fetchMock).get("file") as File;
      expect(submitted.name).toBe(name);
      expect(submitted.type).toBe(expectedType);
      expect(submitted.lastModified).toBe(1234);
      expect(new Uint8Array(await submitted.arrayBuffer())).toEqual(
        new Uint8Array([0, 1, 2, 255]),
      );
    },
  );

  test("applies the same normalization to compatibility batch uploads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    const heic = new File(["heic"], "one.heic", { type: "image/heif" });
    const jpeg = new File(["jpeg"], "two.jpg", { type: "image/jpeg" });

    await uploadPhotoBatch([heic, jpeg]);

    const submitted = submittedFormData(fetchMock).getAll("files") as File[];
    expect(submitted.map((file) => [file.name, file.type])).toEqual([
      ["one.heic", "image/heic"],
      ["two.jpg", "image/jpeg"],
    ]);
  });
});
