import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function photo(id = 1): Photo {
  return {
    id,
    original_filename: "existing-fox.jpg",
    stored_filename: `${id}.jpg`,
    resized_filename: `${id}-resized.jpg`,
    thumbnail_filename: `${id}-thumb.jpg`,
    display_title: "Red fox",
    common_name: "fox",
    breed_guess: null,
    species_guess: "Vulpes vulpes",
    category: "mammal",
    confidence: null,
    description: null,
    tags: [],
    status: "classified",
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
    photo_id: 1,
    original_filename: "existing-fox.jpg",
    display_title: "Red fox",
    common_name: "fox",
    species_guess: "Vulpes vulpes",
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

async function selectFile(name = "new-fox.jpg") {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("Upload input not found");
  const file = new File(["image"], name, { type: "image/jpeg" });
  await userEvent.upload(input, file);
  return file;
}

test("reviews a possible duplicate and keeps both with explicit override", async () => {
  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockResolvedValueOnce(photo(2));

  render(<Home />);
  const file = await selectFile();
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));

  expect(
    await screen.findByRole("dialog", { name: "Possible duplicate" }),
  ).toBeTruthy();
  expect(screen.getByAltText("Uploaded photo: new-fox.jpg")).toBeTruthy();
  const existingPreview = screen.getByAltText("Existing photo: Red fox");
  expect(existingPreview.getAttribute("src")).toContain("/photos/1/thumbnail");
  expect(existingPreview.getAttribute("src")).not.toContain("thumb.jpg");

  await userEvent.click(screen.getByRole("button", { name: "Keep both" }));
  await waitFor(() => expect(api.uploadPhoto).toHaveBeenLastCalledWith(file, true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("Uploaded")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/1 file: 1 uploaded/i);
});

test("keeps duplicate-review focus trapped and restores the upload trigger on Escape", async () => {
  api.uploadPhoto.mockRejectedValue(
    new ApiError("Looks similar", 409, {
      code: "possible_visual_duplicate",
      candidates: [candidate()],
    }),
  );

  const user = userEvent.setup();
  render(<Home />);
  await selectFile();
  const trigger = screen.getByRole("button", { name: "Upload photo" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Possible duplicate" });
  const keep = screen.getByRole("button", { name: "Keep both" });
  const existingLink = screen.getByRole("link", { name: "View existing photo" });

  expect(document.activeElement).toBe(keep);
  expect(document.body.style.overflow).toBe("hidden");
  await user.tab();
  expect(document.activeElement).toBe(existingLink);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(keep);
  fireEvent.keyDown(dialog, { key: "Escape" });

  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      document.querySelector<HTMLInputElement>('input[type="file"]'),
    ),
  );
  expect(document.body.style.overflow).toBe("");
});

test("cancels one flagged batch item without blocking successful files", async () => {
  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate("trash")],
      }),
    )
    .mockResolvedValueOnce(photo(2))
    .mockRejectedValueOnce(
      new ApiError("Uploaded file is not a valid image", 400),
    );

  render(<Home />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, [
    new File(["near"], "near.jpg", { type: "image/jpeg" }),
    new File(["new"], "new.jpg", { type: "image/jpeg" }),
    new File(["bad"], "broken.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));

  expect(await screen.findByText("Trash")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toMatch(/1 file needs review/i);
  expect(screen.getByText("Uploaded")).toBeTruthy();
  expect(screen.getByText("Failed")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  expect(await screen.findByText("Cancelled")).toBeTruthy();
  expect(api.uploadPhoto).toHaveBeenCalledTimes(3);
  expect(api.uploadPhotoBatch).not.toHaveBeenCalled();
});

test("keeps the review open when confirmation fails", async () => {
  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockRejectedValueOnce(new ApiError("Could not save the uploaded photo", 500));

  render(<Home />);
  await selectFile();
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Keep both" }),
  );

  expect(await screen.findByText("Could not save the uploaded photo")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Possible duplicate" })).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Keep both" }).disabled,
  ).toBe(false);
});

test("does not dismiss or resubmit duplicate review while Keep both is pending", async () => {
  let resolveKeep: (value: Photo) => void = () => undefined;
  api.uploadPhoto
    .mockRejectedValueOnce(
      new ApiError("Looks similar", 409, {
        code: "possible_visual_duplicate",
        candidates: [candidate()],
      }),
    )
    .mockImplementationOnce(
      () => new Promise<Photo>((resolve) => { resolveKeep = resolve; }),
    );

  render(<Home />);
  await selectFile();
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));
  await userEvent.click(await screen.findByRole("button", { name: "Keep both" }));

  const dialog = screen.getByRole("dialog");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Keeping both photos" }).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBe(dialog);
  await userEvent.click(screen.getByRole("button", { name: "Keeping both photos" }));
  expect(api.uploadPhoto).toHaveBeenCalledTimes(2);

  resolveKeep(photo(2));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("keeps exact duplicate handling separate from visual review", async () => {
  api.uploadPhoto.mockRejectedValue(
    new ApiError("This image is already in FaunaVault.", 409, {
      code: "duplicate_photo",
      photo_id: 1,
      location: "catalog",
    }),
  );

  render(<Home />);
  await selectFile("exact.jpg");
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));

  expect(await screen.findByText("This image is already in FaunaVault.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View existing photo" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("revokes the uploaded preview URL when duplicate review closes", async () => {
  api.uploadPhoto.mockRejectedValue(
    new ApiError("Looks similar", 409, {
      code: "possible_visual_duplicate",
      candidates: [candidate()],
    }),
  );
  render(<Home />);
  await selectFile();
  await userEvent.click(screen.getByRole("button", { name: "Upload photo" }));
  await screen.findByRole("dialog", { name: "Possible duplicate" });

  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  await waitFor(() =>
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:uploaded-preview"),
  );
});

test("keeps retained files matched to multiple review queue entries", async () => {
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
    );
  render(<Home />);
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, [
    new File(["first"], "first.jpg", { type: "image/jpeg" }),
    new File(["second"], "second.jpg", { type: "image/jpeg" }),
  ]);
  await userEvent.click(screen.getByRole("button", { name: "Upload photos" }));

  expect(await screen.findByAltText("Uploaded photo: first.jpg")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
  expect(await screen.findByAltText("Uploaded photo: second.jpg")).toBeTruthy();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
});
