import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import { useCatalogSelection } from "../app/hooks/use-catalog-selection";
import {
  BulkPhotoRequest,
  CatalogQuery,
  Photo,
} from "../app/lib/api";

const api = vi.hoisted(() => ({
  addPhotosToCollection: vi.fn(),
  bulkUpdatePhotos: vi.fn(),
  getCatalogPhotos: vi.fn(),
  getCatalogTaxa: vi.fn(),
  getClassificationJobs: vi.fn(),
  getCollections: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

function photo(id: number, title: string, filename = "duplicate.jpg"): Photo {
  return {
    id,
    original_filename: filename,
    stored_filename: `${id}.jpg`,
    resized_filename: `${id}-resized.jpg`,
    thumbnail_filename: `${id}-thumb.jpg`,
    display_title: title,
    common_name: null,
    breed_guess: null,
    species_guess: null,
    category: id % 2 ? "mammal" : "bird",
    confidence: null,
    description: null,
    tags: [],
    status: "classified",
    animal_id: id,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    deleted_at: null,
    created_at: "2026-08-23T08:00:00Z",
    updated_at: "2026-08-23T08:00:00Z",
  };
}

const firstPage = [photo(1, "First fox"), photo(2, "Second fox")];
const secondPage = [photo(3, "Third fox", "third.jpg")];

function catalogPage(query: CatalogQuery) {
  const items = query.page === 2 ? secondPage : firstPage;
  return {
    items,
    total: 3,
    page: query.page,
    page_size: query.page_size,
    total_pages: 2,
    facets: {
      active_total: 3,
      status_counts: { pending: 0, classified: 3, needs_review: 0 },
      categories: [
        { value: "bird", count: 1 },
        { value: "mammal", count: 2 },
      ],
      uncategorized_count: 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  api.getCollections.mockResolvedValue([
    {
      id: 9,
      name: "Favorites",
      active_photo_count: 4,
      created_at: "2026-08-23T08:00:00Z",
      updated_at: "2026-08-23T08:00:00Z",
    },
  ]);
  api.addPhotosToCollection.mockResolvedValue({
    collection_id: 9,
    requested_count: 2,
    added_count: 1,
    already_present_count: 1,
  });
  api.bulkUpdatePhotos.mockImplementation(async (request: BulkPhotoRequest) => ({
    status: "completed",
    operation: request.operation,
    photo_ids: request.photo_ids,
    affected_count: request.photo_ids.length,
  }));
});

async function enterAndSelectPage() {
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Select page" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
}

test("selection uses photo IDs so duplicate filenames remain independent", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));

  const first = screen.getByRole("checkbox", { name: "Select photo 1: First fox" });
  const second = screen.getByRole("checkbox", { name: "Select photo 2: Second fox" });
  await userEvent.click(first);
  expect((first as HTMLInputElement).checked).toBe(true);
  expect((second as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("1 selected")).toBeTruthy();
  expect(screen.queryAllByRole("button", { name: "Move to Trash" })).toHaveLength(1);

  await userEvent.click(second);
  expect(screen.getAllByText("Selected")).toHaveLength(2);
  await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect((first as HTMLInputElement).checked).toBe(false);
  expect((second as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("0 selected")).toBeTruthy();
});

test("selection spans pages and layouts but clears immediately for a new query", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Next" }));

  expect(await screen.findByRole("heading", { name: "Third fox" })).toBeTruthy();
  expect(screen.getByText("2 selected · 0 on this page")).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "Select page" }));
  expect(screen.getByText("3 selected · 1 on this page")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Group by category" }));
  expect(await screen.findByText("3 selected · 1 on this page")).toBeTruthy();

  await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "fox");
  expect(screen.queryByRole("region", { name: "Bulk photo actions" })).toBeNull();
  expect(screen.getByRole("button", { name: "Select photos" })).toBeTruthy();
});

test("selection resets for browser URL context changes and rejects oversized pages", async () => {
  const { result, rerender } = renderHook(
    ({ contextKey }) => useCatalogSelection(contextKey),
    { initialProps: { contextKey: "first" } },
  );
  act(() => result.current.enter());
  act(() => result.current.togglePage(Array.from({ length: 251 }, (_, index) => index + 1)));
  expect(result.current.selectedCount).toBe(0);
  expect(result.current.error).toContain("250");
  act(() => result.current.togglePage(Array.from({ length: 250 }, (_, index) => index + 1)));
  expect(result.current.selectedCount).toBe(250);
  rerender({ contextKey: "second" });
  await waitFor(() => expect(result.current.selectedCount).toBe(0));
  expect(result.current.isSelecting).toBe(false);

  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  window.history.pushState(null, "", "/?catalog_status=classified");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "Bulk photo actions" })).toBeNull(),
  );
});

test("tag and category dialogs send explicit typed operations", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });

  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Add tags" }));
  let dialog = screen.getByRole("dialog", {
    name: "Add tags to 2 selected photos",
  });
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Tags, separated by commas" }),
    " bird, summer, bird ",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Add tags" }));
  await waitFor(() =>
    expect(api.bulkUpdatePhotos).toHaveBeenLastCalledWith({
      photo_ids: [1, 2],
      operation: "add_tags",
      tags: ["bird", "summer"],
    }),
  );

  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Remove tags" }));
  dialog = screen.getByRole("dialog", {
    name: "Remove tags from 2 selected photos",
  });
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: "Tags, separated by commas" }),
    "summer",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove tags" }));
  await waitFor(() =>
    expect(api.bulkUpdatePhotos).toHaveBeenLastCalledWith({
      photo_ids: [1, 2],
      operation: "remove_tags",
      tags: ["summer"],
    }),
  );

  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Set category" }));
  dialog = screen.getByRole("dialog", { name: "Set category for 2 photos" });
  await userEvent.type(
    within(dialog).getByRole("combobox", { name: "Category value" }),
    "field note",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Set category" }));
  await waitFor(() =>
    expect(api.bulkUpdatePhotos).toHaveBeenLastCalledWith({
      photo_ids: [1, 2],
      operation: "set_category",
      category: "field note",
    }),
  );

  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Set category" }));
  dialog = screen.getByRole("dialog", { name: "Set category for 2 photos" });
  await userEvent.click(within(dialog).getByRole("radio", { name: "Clear category" }));
  expect(
    screen.getByRole("dialog", { name: "Clear category for 2 photos" }),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Clear category" }));
  await waitFor(() =>
    expect(api.bulkUpdatePhotos).toHaveBeenLastCalledWith({
      photo_ids: [1, 2],
      operation: "clear_category",
    }),
  );
});

test("Move to Trash focuses the safe action and failures preserve selection", async () => {
  api.bulkUpdatePhotos.mockRejectedValueOnce(new Error("Lifecycle unavailable"));
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));

  const dialog = screen.getByRole("dialog", { name: "Move 2 photos to Trash?" });
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect(within(dialog).getByText(/not permanent deletion/i)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Lifecycle unavailable",
  );
  expect(screen.getByText("2 selected")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Move 2 photos to Trash?" })).toBeTruthy();
});

test("a successful mutation clears selection even when the refresh fails", async () => {
  api.getCatalogPhotos
    .mockImplementationOnce(async (query: CatalogQuery) => catalogPage(query))
    .mockRejectedValueOnce(new Error("Refresh offline"));
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
  const dialog = screen.getByRole("dialog", { name: "Move 2 photos to Trash?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));

  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("region", { name: "Bulk photo actions" })).toBeNull();
  expect(await screen.findByText(/action succeeded.*catalog could not refresh/i)).toBeTruthy();
  expect(api.bulkUpdatePhotos).toHaveBeenCalledTimes(1);
});

test("Add to Collection sends the exact selected IDs and clears only after success", async () => {
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Add to Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Add 2 photos to Collection" });
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  await userEvent.click(await within(dialog).findByRole("radio", { name: /Favorites/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Add to Collection" }));

  await waitFor(() =>
    expect(api.addPhotosToCollection).toHaveBeenCalledWith(9, { photo_ids: [1, 2] }),
  );
  expect(screen.queryByRole("region", { name: "Bulk photo actions" })).toBeNull();
  expect(screen.getByRole("status").textContent).toContain(
    "Added 1 photo to the Collection; 1 was already present.",
  );
  expect(api.getCatalogPhotos).toHaveBeenCalledTimes(1);
});

test("Add to Collection failure preserves the dialog and selection", async () => {
  api.addPhotosToCollection.mockRejectedValueOnce(new Error("Collection unavailable"));
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Add to Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Add 2 photos to Collection" });
  await userEvent.click(await within(dialog).findByRole("radio", { name: /Favorites/ }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Add to Collection" }));

  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Collection unavailable",
  );
  expect(screen.getByText("2 selected")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "Add 2 photos to Collection" })).toBeTruthy();
});

test("Add to Collection explains that an existing Collection is required", async () => {
  api.getCollections.mockResolvedValueOnce([]);
  render(<Home />);
  await screen.findByRole("heading", { name: "First fox" });
  await enterAndSelectPage();
  await userEvent.click(screen.getByRole("button", { name: "Add to Collection" }));
  const dialog = screen.getByRole("dialog", { name: "Add 2 photos to Collection" });
  const createLink = await within(dialog).findByRole("link", {
    name: "Create a Collection first",
  });
  expect(createLink.getAttribute("href")).toBe("/collections");
  expect(within(dialog).queryByRole("radio")).toBeNull();
});
