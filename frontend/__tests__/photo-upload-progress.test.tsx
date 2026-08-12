import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import {
  ApiError,
  CatalogQuery,
  Photo,
  VisualDuplicateCandidate,
} from "../app/lib/api";

const api = vi.hoisted(() => ({
  getCatalogPhotos: vi.fn(),
  getCatalogTaxa: vi.fn(),
  getClassificationJobs: vi.fn(),
  uploadPhoto: vi.fn(),
  uploadPhotoBatch: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return { ...original, ...api };
});

function photo(id: number, filename = `photo-${id}.jpg`): Photo {
  return {
    id,
    original_filename: filename,
    stored_filename: `${id}.jpg`,
    resized_filename: `${id}-resized.jpg`,
    thumbnail_filename: `${id}-thumb.jpg`,
    display_title: null,
    common_name: null,
    breed_guess: null,
    species_guess: null,
    category: null,
    confidence: null,
    description: null,
    tags: [],
    status: "pending",
    animal_id: id,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    deleted_at: null,
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
  };
}

function candidate(location: "catalog" | "trash" = "catalog"): VisualDuplicateCandidate {
  return {
    photo_id: 91,
    original_filename: "existing.jpg",
    display_title: "Existing animal",
    common_name: null,
    species_guess: null,
    location,
    hamming_distance: 2,
  };
}

function catalogPage(query: CatalogQuery) {
  return {
    items: [],
    total: 0,
    page: query.page,
    page_size: query.page_size,
    total_pages: 0,
    facets: {
      active_total: 0,
      status_counts: { pending: 0, classified: 0, needs_review: 0 },
      categories: [],
      uncategorized_count: 0,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function selectFiles(files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("Upload input not found");
  await userEvent.upload(input, files);
  return input;
}

function row(filename: string, occurrence = 0) {
  const filenameNode = screen.getAllByTitle(filename)[occurrence];
  const item = filenameNode.closest("li");
  if (!item) throw new Error(`Upload row not found for ${filename}`);
  return within(item);
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) =>
    catalogPage(query),
  );
  api.getCatalogTaxa.mockResolvedValue({
    items: [],
    selected: null,
    page: 1,
    page_size: 50,
    total: 0,
    total_pages: 0,
  });
  api.getClassificationJobs.mockResolvedValue({
    jobs: [],
    summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
  });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:uploaded-preview"),
      revokeObjectURL: vi.fn(),
    }),
  );
});

test("shows queued rows immediately and uploads only one file at a time", async () => {
  const first = deferred<Photo>();
  const second = deferred<Photo>();
  const third = deferred<Photo>();
  api.uploadPhoto
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);

  render(<Home />);
  const files = [
    new File(["one"], "one.jpg", { type: "image/jpeg" }),
    new File(["two"], "two.jpg", { type: "image/jpeg" }),
    new File(["three"], "three.jpg", { type: "image/jpeg" }),
  ];
  const input = await selectFiles(files);

  expect(row("one.jpg").getByText("Waiting")).toBeTruthy();
  expect(row("two.jpg").getByText("Waiting")).toBeTruthy();
  expect(row("three.jpg").getByText("Waiting")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));
  await waitFor(() => expect(api.uploadPhoto).toHaveBeenCalledTimes(1));
  expect(api.uploadPhoto).toHaveBeenNthCalledWith(1, files[0]);
  expect(row("one.jpg").getByText("Uploading")).toBeTruthy();
  expect(row("two.jpg").getByText("Waiting")).toBeTruthy();
  expect(input.disabled).toBe(true);

  first.resolve(photo(1, "one.jpg"));
  await waitFor(() => expect(api.uploadPhoto).toHaveBeenCalledTimes(2));
  expect(api.uploadPhoto).toHaveBeenNthCalledWith(2, files[1]);
  expect(row("one.jpg").getByText("Uploaded")).toBeTruthy();
  expect(row("two.jpg").getByText("Uploading")).toBeTruthy();

  second.resolve(photo(2, "two.jpg"));
  await waitFor(() => expect(api.uploadPhoto).toHaveBeenCalledTimes(3));
  expect(api.uploadPhoto).toHaveBeenNthCalledWith(3, files[2]);
  third.resolve(photo(3, "three.jpg"));

  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/3 files: 3 uploaded/i));
  expect(input.disabled).toBe(false);
  expect(api.uploadPhotoBatch).not.toHaveBeenCalled();
});

test("isolates mixed upload outcomes and reviews duplicates after the initial pass", async () => {
  api.uploadPhoto
    .mockResolvedValueOnce(photo(1, "success.jpg"))
    .mockRejectedValueOnce(
      new ApiError("This image is already in FaunaVault.", 409, {
        code: "duplicate_photo",
        photo_id: 12,
        location: "catalog",
      }),
    )
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockRejectedValueOnce(new ApiError("Uploaded file is not a valid image", 400))
    .mockResolvedValueOnce(photo(5, "later.jpg"));

  render(<Home />);
  await selectFiles([
    new File(["success"], "success.jpg", { type: "image/jpeg" }),
    new File(["exact"], "exact.jpg", { type: "image/jpeg" }),
    new File(["near"], "near.jpg", { type: "image/jpeg" }),
    new File(["bad"], "broken.jpg", { type: "image/jpeg" }),
    new File(["later"], "later.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));

  expect(await screen.findByRole("dialog", { name: "Possible duplicate" })).toBeTruthy();
  expect(api.uploadPhoto).toHaveBeenCalledTimes(5);
  expect(row("success.jpg").getByText("Uploaded")).toBeTruthy();
  expect(row("exact.jpg").getByText("Exact duplicate")).toBeTruthy();
  expect(row("near.jpg").getByText("Possible duplicate")).toBeTruthy();
  expect(row("broken.jpg").getByText("Failed")).toBeTruthy();
  expect(row("broken.jpg").queryByRole("button", { name: /retry/i })).toBeNull();
  expect(row("later.jpg").getByText("Uploaded")).toBeTruthy();
  expect(row("exact.jpg").getByRole("link", { name: "View existing photo" })).toBeTruthy();
  expect(api.uploadPhotoBatch).not.toHaveBeenCalled();
});

test("retries only a transient failed item and preserves completed siblings", async () => {
  const firstFile = new File(["first"], "first.jpg", { type: "image/jpeg" });
  api.uploadPhoto
    .mockRejectedValueOnce(new ApiError("Could not save the uploaded photo", 500))
    .mockResolvedValueOnce(photo(2, "second.jpg"))
    .mockResolvedValueOnce(photo(1, "first.jpg"));

  render(<Home />);
  await selectFiles([
    firstFile,
    new File(["second"], "second.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));

  const retry = await screen.findByRole("button", {
    name: "Retry file 1, first.jpg",
  });
  expect(row("first.jpg").getByText("Failed")).toBeTruthy();
  expect(row("second.jpg").getByText("Uploaded")).toBeTruthy();

  await userEvent.click(retry);
  await waitFor(() => expect(row("first.jpg").getByText("Uploaded")).toBeTruthy());
  expect(row("second.jpg").getByText("Uploaded")).toBeTruthy();
  expect(api.uploadPhoto).toHaveBeenLastCalledWith(firstFile);
});

test("keeps duplicate filenames associated with their original File objects", async () => {
  const first = new File(["near"], "same.jpg", { type: "image/jpeg" });
  const second = new File(["new"], "same.jpg", { type: "image/jpeg" });
  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockResolvedValueOnce(photo(2, "same.jpg"));

  render(<Home />);
  await selectFiles([first, second]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));

  expect(await screen.findByAltText("Uploaded photo: same.jpg")).toBeTruthy();
  expect(api.uploadPhoto).toHaveBeenNthCalledWith(1, first);
  expect(api.uploadPhoto).toHaveBeenNthCalledWith(2, second);
  expect(row("same.jpg", 0).getByText("Possible duplicate")).toBeTruthy();
  expect(row("same.jpg", 1).getByText("Uploaded")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  expect(await row("same.jpg", 0).findByText("Cancelled")).toBeTruthy();
  expect(row("same.jpg", 1).getByText("Uploaded")).toBeTruthy();
});

test("batches catalog refreshes across initial uploads and duplicate reviews", async () => {
  render(<Home />);
  await waitFor(() => expect(api.getCatalogPhotos).toHaveBeenCalled());
  const initialCatalogCalls = api.getCatalogPhotos.mock.calls.length;

  api.uploadPhoto
    .mockResolvedValueOnce(photo(1, "one.jpg"))
    .mockResolvedValueOnce(photo(2, "two.jpg"));
  await selectFiles([
    new File(["one"], "one.jpg", { type: "image/jpeg" }),
    new File(["two"], "two.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/2 files: 2 uploaded/i));
  expect(api.getCatalogPhotos).toHaveBeenCalledTimes(initialCatalogCalls + 1);

  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockResolvedValueOnce(photo(3, "near-one.jpg"))
    .mockResolvedValueOnce(photo(4, "near-two.jpg"));
  await selectFiles([
    new File(["near-one"], "near-one.jpg", { type: "image/jpeg" }),
    new File(["near-two"], "near-two.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));
  await userEvent.click(await screen.findByRole("button", { name: "Keep both" }));
  await userEvent.click(await screen.findByRole("button", { name: "Keep both" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.getCatalogPhotos).toHaveBeenCalledTimes(initialCatalogCalls + 2);
});

test("turns a Keep both race into an exact duplicate result", async () => {
  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockRejectedValueOnce(
      new ApiError("This image is already in FaunaVault.", 409, {
        code: "duplicate_photo",
        photo_id: 44,
        location: "trash",
      }),
    );

  render(<Home />);
  await selectFiles([
    new File(["near"], "race.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));
  await userEvent.click(await screen.findByRole("button", { name: "Keep both" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(row("race.jpg").getByText("Exact duplicate")).toBeTruthy();
  expect(row("race.jpg").getByRole("button", { name: "View Trash" })).toBeTruthy();
  expect(api.uploadPhoto).toHaveBeenLastCalledWith(expect.any(File), true);
});

test("preserves accepted item states when catalog refresh fails", async () => {
  render(<Home />);
  await waitFor(() => expect(api.getCatalogPhotos).toHaveBeenCalled());
  api.getCatalogPhotos.mockRejectedValueOnce(new Error("Catalog offline"));
  api.uploadPhoto.mockResolvedValueOnce(photo(1, "saved.jpg"));

  await selectFiles([
    new File(["saved"], "saved.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));

  expect(await row("saved.jpg").findByText("Uploaded")).toBeTruthy();
  expect(
    await screen.findByText(/uploads were saved, but the catalog could not be refreshed/i),
  ).toBeTruthy();
});

test("does not refresh the catalog after an upload resolves post-unmount", async () => {
  const pending = deferred<Photo>();
  api.uploadPhoto.mockReturnValueOnce(pending.promise);
  const view = render(<Home />);
  await waitFor(() => expect(api.getCatalogPhotos).toHaveBeenCalled());
  const initialCatalogCalls = api.getCatalogPhotos.mock.calls.length;

  await selectFiles([
    new File(["late"], "late.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));
  await waitFor(() => expect(api.uploadPhoto).toHaveBeenCalledTimes(1));
  view.unmount();
  pending.resolve(photo(1, "late.jpg"));
  await Promise.resolve();
  await Promise.resolve();

  expect(api.getCatalogPhotos).toHaveBeenCalledTimes(initialCatalogCalls);
});
