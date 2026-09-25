import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import CollectionsBrowser from "../app/collections/collections-browser";
import SmartCollectionDetail from "../app/collections/smart/[id]/smart-collection-detail";

const api = vi.hoisted(() => ({
  getCollections: vi.fn(), getSmartCollections: vi.fn(), getSmartCollection: vi.fn(),
  getSmartCollectionPhotos: vi.fn(), updateSmartCollection: vi.fn(), deleteSmartCollection: vi.fn(),
}));
vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()), ...api,
}));

const now = "2026-09-25T08:00:00Z";
const smart = {
  id: 7, name: "Foxes", query_version: 1, query_valid: true, query_error: null,
  query: { search: "fox", sort: "created_at", order: "desc" }, created_at: now, updated_at: now,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/collections");
  api.getCollections.mockResolvedValue([{ id: 3, name: "Foxes", active_photo_count: 1, created_at: now, updated_at: now }]);
  api.getSmartCollections.mockResolvedValue([{ ...smart }]);
  api.getSmartCollection.mockResolvedValue({ ...smart });
  api.getSmartCollectionPhotos.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 48, total_pages: 0, facets: { active_total: 0, status_counts: { pending: 0, classified: 0, needs_review: 0 }, categories: [], uncategorized_count: 0 } });
  api.updateSmartCollection.mockResolvedValue({ ...smart, name: "Foxes 2026" });
  api.deleteSmartCollection.mockResolvedValue({ status: "deleted", smart_collection_id: 7 });
});

test("index distinguishes manual and Smart Collections and isolates an invalid saved query", async () => {
  api.getSmartCollections.mockResolvedValue([{ ...smart, query_valid: false, query_error: "Unsupported saved query version 99." }]);
  render(<CollectionsBrowser />);
  expect(await screen.findByRole("heading", { name: "Smart Collections" })).toBeTruthy();
  expect(screen.getAllByRole("link", { name: /Foxes/ }).map((link) => link.getAttribute("href"))).toEqual(["/collections/3", "/collections/smart/7"]);
  expect(screen.getByText("Unsupported saved query version 99.")).toBeTruthy();
});

test("Smart detail shows criteria, empty results, URL page correction, and edit link", async () => {
  window.history.replaceState(null, "", "/collections/smart/7?page=4");
  render(<SmartCollectionDetail collectionId={7} />);
  expect(await screen.findByRole("heading", { name: "Foxes" })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "No matching photos" })).toBeTruthy();
  expect(screen.getByText(/Search: fox/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Edit criteria" }).getAttribute("href")).toContain("smart_edit=7");
  await waitFor(() => expect(window.location.search).toBe(""));
  expect(api.getSmartCollectionPhotos).toHaveBeenCalledWith(7, 4, expect.any(AbortSignal));
});

test("Smart detail renames and deletes without a membership action", async () => {
  window.history.replaceState(null, "", "/collections/smart/7");
  render(<SmartCollectionDetail collectionId={7} />);
  await screen.findByRole("heading", { name: "Foxes" });
  expect(screen.queryByRole("button", { name: "Remove from Collection" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Rename" }));
  const dialog = screen.getByRole("dialog", { name: "Rename Smart Collection" });
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Smart Collection name" }));
  await userEvent.type(within(dialog).getByRole("textbox", { name: "Smart Collection name" }), "Foxes 2026");
  await userEvent.click(within(dialog).getByRole("button", { name: "Rename Smart Collection" }));
  await waitFor(() => expect(api.updateSmartCollection).toHaveBeenCalledWith(7, { name: "Foxes 2026" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete Smart Collection" }));
  const deleteDialog = screen.getByRole("dialog", { name: "Delete Smart Collection “Foxes 2026”?" });
  await userEvent.click(within(deleteDialog).getByRole("button", { name: "Delete Smart Collection" }));
  await waitFor(() => expect(api.deleteSmartCollection).toHaveBeenCalledWith(7));
  await waitFor(() => expect(window.location.pathname).toBe("/collections"));
});

test("Smart detail keeps invalid definition visible and allows replacement", async () => {
  window.history.replaceState(null, "", "/collections/smart/7");
  api.getSmartCollection.mockResolvedValue({ ...smart, query: null, query_valid: false, query_error: "Unsupported saved query version 99." });
  render(<SmartCollectionDetail collectionId={7} />);
  expect(await screen.findByRole("link", { name: "Replace criteria" })).toBeTruthy();
  expect(api.getSmartCollectionPhotos).not.toHaveBeenCalled();
});

test("Smart Collection request failures show retry actions", async () => {
  api.getSmartCollections.mockRejectedValueOnce(new Error("List unavailable"));
  render(<CollectionsBrowser />);
  expect(await screen.findByText("List unavailable")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "Smart Collections" })).toBeTruthy();
  await waitFor(() => expect(api.getSmartCollections).toHaveBeenCalledTimes(2));
});

test("Smart detail shows a results error without hiding its saved criteria", async () => {
  window.history.replaceState(null, "", "/collections/smart/7");
  api.getSmartCollectionPhotos.mockRejectedValueOnce(new Error("Results unavailable"));
  render(<SmartCollectionDetail collectionId={7} />);
  expect(await screen.findByText("Results unavailable")).toBeTruthy();
  expect(screen.getByText(/Search: fox/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.getSmartCollectionPhotos).toHaveBeenCalledTimes(2));
});
