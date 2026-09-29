import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import CollectionsBrowser from "../app/collections/collections-browser";
import CollectionDetailView from "../app/collections/[id]/collection-detail";
import type { CollectionDetail, CollectionSummary, Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getCollections: vi.fn(),
  getSmartCollections: vi.fn(),
  createCollection: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
  getCollection: vi.fn(),
  removePhotosFromCollection: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

const now = "2026-08-23T08:00:00Z";

function summary(overrides: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    id: 7,
    name: "Field notes",
    active_photo_count: 1,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function photo(id = 11): Photo {
  return {
    id,
    original_filename: `fox-${id}.jpg`,
    stored_filename: `${id}.jpg`,
    resized_filename: `${id}-resized.jpg`,
    thumbnail_filename: `${id}-thumb.jpg`,
    display_title: `Fox ${id}`,
    common_name: "fox",
    breed_guess: null,
    species_guess: "Vulpes vulpes",
    category: "mammal",
    confidence: 0.9,
    description: null,
    tags: [],
    status: "classified",
    animal_id: id,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    captured_at: null, captured_at_offset_minutes: null,
    camera_make: null, camera_model: null, lens_model: null,
    image_width: null, image_height: null, latitude: null, longitude: null,
    deleted_at: null,
    reviewed_at: null,
    created_at: now,
    updated_at: now,
  };
}

function detail(items = [photo()]): CollectionDetail {
  return {
    ...summary({ active_photo_count: items.length }),
    photos: {
      items,
      total: items.length,
      page: 1,
      page_size: 48,
      total_pages: items.length ? 1 : 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/collections");
  api.getCollections.mockResolvedValue([summary()]);
  api.getSmartCollections.mockResolvedValue([]);
  api.createCollection.mockResolvedValue(summary({ id: 8, name: "Trips", active_photo_count: 0 }));
  api.renameCollection.mockResolvedValue(summary({ name: "Renamed" }));
  api.deleteCollection.mockResolvedValue({ status: "deleted", collection_id: 7 });
  api.getCollection.mockResolvedValue(detail());
  api.removePhotosFromCollection.mockResolvedValue({
    collection_id: 7,
    requested_count: 1,
    removed_count: 1,
    already_absent_count: 0,
  });
});

test("Collection index creates with the backend-normalized name and prevents duplicate submit", async () => {
  let resolveCreate!: (value: CollectionSummary) => void;
  api.createCollection.mockReturnValueOnce(new Promise((resolve) => { resolveCreate = resolve; }));
  render(<CollectionsBrowser />);
  expect(await screen.findByRole("heading", { name: "Field notes" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Archive views" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Albums" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Collections" }).getAttribute("aria-current")).toBe("page");

  const trigger = screen.getByRole("button", { name: "Create Collection" });
  await userEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Create Collection" });
  const input = within(dialog).getByRole("textbox", { name: "Collection name" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  await userEvent.type(input, "  Trips  ");
  const submit = within(dialog).getByRole("button", { name: "Create Collection" });
  await userEvent.click(submit);
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  expect(api.createCollection).toHaveBeenCalledTimes(1);
  resolveCreate(summary({ id: 8, name: "Trips", active_photo_count: 0 }));
  expect(await screen.findByRole("heading", { name: "Trips" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Created Collection “Trips”");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("empty Collection index surfaces an authoritative create conflict without closing", async () => {
  api.getCollections.mockResolvedValueOnce([]);
  api.createCollection.mockRejectedValueOnce(
    new Error("A Collection with this name already exists."),
  );
  render(<CollectionsBrowser />);
  expect(await screen.findByRole("heading", { name: "No Collections yet" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Create Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Create Collection" });
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Collection name" }),
    "Existing",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Create Collection" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "already exists",
  );
  expect(screen.getByRole("dialog", { name: "Create Collection" })).toBeTruthy();
});

test("Collection index renames and confirms safe deletion with Cancel focused", async () => {
  render(<CollectionsBrowser />);
  await screen.findByRole("heading", { name: "Field notes" });
  await userEvent.click(screen.getByRole("button", { name: "Rename" }));
  const renameDialog = screen.getByRole("dialog", { name: "Rename Collection" });
  const input = within(renameDialog).getByRole("textbox", { name: "Collection name" });
  await userEvent.clear(input);
  await userEvent.type(input, "Renamed");
  await userEvent.click(within(renameDialog).getByRole("button", { name: "Rename Collection" }));
  expect(await screen.findByRole("heading", { name: "Renamed" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Delete Collection" }));
  const deleteDialog = screen.getByRole("dialog", { name: "Delete collection “Renamed”?" });
  expect(within(deleteDialog).getByText(/including any currently in Trash/)).toBeTruthy();
  expect(within(deleteDialog).getByText(/Photo files are not deleted/)).toBeTruthy();
  const cancel = within(deleteDialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  await userEvent.click(within(deleteDialog).getByRole("button", { name: "Delete Collection" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Renamed" })).toBeNull());
  expect(api.deleteCollection).toHaveBeenCalledWith(7);
});

test("Collection detail reuses photo cards and removes only membership", async () => {
  window.history.replaceState(null, "", "/collections/7");
  api.getCollection.mockImplementation(async () =>
    api.removePhotosFromCollection.mock.calls.length ? detail([]) : detail(),
  );
  render(<CollectionDetailView collectionId={7} />);
  const heading = await screen.findByRole("heading", { name: "Fox 11" });
  const card = heading.closest("article")!;
  expect(within(card).getAllByRole("link")[0].getAttribute("href")).toContain(
    "returnTo=%2Fcollections%2F7",
  );
  await userEvent.click(within(card).getByRole("button", { name: "Remove from Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Remove 1 photo from “Field notes”?" });
  expect(within(dialog).getByText(/membership only/)).toBeTruthy();
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove from Collection" }));
  expect(await screen.findByText("No photos in this collection yet.")).toBeTruthy();
  expect(api.removePhotosFromCollection).toHaveBeenCalledWith(7, { photo_ids: [11] });
});

test("failed selected removal keeps the dialog and Collection-local selection", async () => {
  window.history.replaceState(null, "", "/collections/7");
  api.removePhotosFromCollection.mockRejectedValueOnce(new Error("Membership unavailable"));
  render(<CollectionDetailView collectionId={7} />);
  await screen.findByRole("heading", { name: "Fox 11" });
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Select page" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove from Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Remove 1 photo from “Field notes”?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove from Collection" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Membership unavailable");
  expect(screen.getByText("1 selected")).toBeTruthy();
});
