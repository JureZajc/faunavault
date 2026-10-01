import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import CompareBrowser from "../app/compare/compare-browser";
import { ApiError, BulkPhotoRequest, CatalogQuery, Photo, PhotoUpdate } from "../app/lib/api";
import { REJECTED_PHOTOS_HREF } from "../app/lib/catalog-query";

const api = vi.hoisted(() => ({ getCatalogPhotos: vi.fn(), getCatalogTaxa: vi.fn(), getClassificationJobs: vi.fn(), bulkUpdatePhotos: vi.fn(), getPhoto: vi.fn(), updatePhoto: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));

function photo(id: number, culling_state: Photo["culling_state"] = "reject"): Photo {
  return {
    id, original_filename: `fox-${id}.jpg`, stored_filename: `${id}.jpg`, resized_filename: `${id}-resized.jpg`, thumbnail_filename: `${id}-thumb.jpg`,
    display_title: `Fox ${id}`, common_name: null, breed_guess: null, species_guess: "Vulpes vulpes", category: "mammal", confidence: null, description: null, tags: [], status: "needs_review", animal_id: null,
    culling_state, is_favorite: true, rating: 5, content_sha256: null, original_size_bytes: null, media_type: "image/jpeg",
    captured_at: null, captured_at_offset_minutes: null, extracted_captured_at: null, extracted_captured_at_offset_minutes: null, extracted_latitude: null, extracted_longitude: null,
    capture_metadata_overridden: false, location_metadata_overridden: false, camera_make: null, camera_model: null, lens_model: null, image_width: null, image_height: null, latitude: null, longitude: null,
    deleted_at: null, reviewed_at: null, created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
  };
}
let photos: Photo[];
let paginated: boolean;
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", REJECTED_PHOTOS_HREF);
  photos = [photo(1), photo(2), photo(3, "pick"), photo(4, null)];
  paginated = false;
  api.getCatalogPhotos.mockImplementation(async (query: CatalogQuery) => {
    const active = photos.filter((p) => !p.deleted_at);
    const matches = active.filter((p) => (!query.culling_state || p.culling_state === query.culling_state) && (!query.search || p.display_title?.includes(query.search)));
    const size = paginated ? 1 : query.page_size;
    return { items: matches.slice((query.page - 1) * size, query.page * size), total: matches.length, total_pages: Math.ceil(matches.length / size), page: query.page, page_size: size,
      facets: { active_total: active.length, status_counts: { pending: 0, classified: 0, needs_review: active.length }, categories: [], uncategorized_count: 0 } };
  });
  api.getCatalogTaxa.mockResolvedValue({ items: [], selected: null, total: 0, page: 1, page_size: 50, total_pages: 0 });
  api.getClassificationJobs.mockResolvedValue({ jobs: [], summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } });
  api.bulkUpdatePhotos.mockImplementation(async (request: BulkPhotoRequest) => {
    photos = photos.map((p) => request.photo_ids.includes(p.id) ? { ...p, ...(request.operation === "move_to_trash" ? { deleted_at: "2026-01-02" } : request.operation === "set_culling_state" ? { culling_state: request.culling_state } : request.operation === "clear_culling_state" ? { culling_state: null } : {}) } : p);
    return { operation: request.operation, photo_ids: request.photo_ids, affected_count: request.photo_ids.length, status: "completed" };
  });
  api.getPhoto.mockImplementation(async (id: string) => ({ ...photos.find((p) => p.id === Number(id)) }));
  api.updatePhoto.mockImplementation(async (id: number, values: PhotoUpdate) => {
    photos = photos.map((p) => p.id === id ? { ...p, ...values, updated_at: "2026-01-02T00:00:00" } : p);
    return { ...photos.find((p) => p.id === id) };
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function select(id = 1) {
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));
  await userEvent.click(screen.getByRole("checkbox", { name: `Select photo ${id}: Fox ${id}` }));
}

test("review uses the Reject URL, catalog count and shared inspection links without individual Trash or permanent deletion", async () => {
  render(<Home />);
  await screen.findByText("2 rejected photos");
  expect(screen.getByRole("heading", { name: "Rejected Photos" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Fox 3" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Fox 4" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Trash/ })).toBeNull();
  const card = screen.getByRole("heading", { name: "Fox 1" }).closest("article")!;
  expect(within(card).getByLabelText("Rejected")).toBeTruthy();
  expect(within(card).getByLabelText("Favorite")).toBeTruthy();
  expect(within(card).getByLabelText("Rated 5 out of 5 stars")).toBeTruthy();
  expect(within(card).getAllByRole("link")[0].getAttribute("href")).toContain(encodeURIComponent(REJECTED_PHOTOS_HREF));
  expect(screen.queryByRole("button", { name: /Permanently/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Move 0 selected photos to Trash" }).disabled).toBe(true);
});

test("explicit selected IDs use guarded Trash, confirmation count, Cancel focus, and leave unselected Reject active", async () => {
  render(<Home />);
  await screen.findByText("2 rejected photos");
  await select();
  await userEvent.click(screen.getByRole("button", { name: "Move 1 selected photo to Trash" }));
  const dialog = screen.getByRole("dialog", { name: "Move 1 selected photo to Trash?" });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
  expect(within(dialog).getByText(/can be restored later/)).toBeTruthy();
  expect(api.bulkUpdatePhotos).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "Move selected to Trash" }));
  await screen.findByText("1 rejected photo");
  expect(api.bulkUpdatePhotos).toHaveBeenCalledWith({ operation: "move_to_trash", expected_culling_state: "reject", photo_ids: [1] });
  expect(screen.queryByRole("heading", { name: "Fox 1" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Fox 2" })).toBeTruthy();
  expect(photos[0]).toMatchObject({ culling_state: "reject", is_favorite: true, rating: 5 });
  expect(photos[1].deleted_at).toBeNull();
});

test.each(["pick", "clear"])("bulk %s removes a mistaken Reject and preserves Favorite/Rating", async (state) => {
  render(<Home />);
  await screen.findByText("2 rejected photos");
  await select();
  await userEvent.click(screen.getByRole("button", { name: "Culling decision" }));
  const dialog = screen.getByRole("dialog");
  await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Culling action" }), state);
  await userEvent.click(within(dialog).getByRole("button", { name: state === "pick" ? "Mark Pick" : "Clear culling decision" }));
  await screen.findByText("1 rejected photo");
  expect(photos[0]).toMatchObject({ culling_state: state === "pick" ? "pick" : null, is_favorite: true, rating: 5, deleted_at: null, status: "needs_review", reviewed_at: null });
});

test("failure retains dialog and selection; explicit refresh reloads membership without resubmitting", async () => {
  api.bulkUpdatePhotos.mockRejectedValueOnce(new ApiError("No photos were moved. Refresh and reselect.", 409, { code: "photos_not_rejected", photo_ids: [1] }));
  render(<Home />);
  await screen.findByText("2 rejected photos");
  await select();
  photos[0].culling_state = "pick";
  await userEvent.click(screen.getByRole("button", { name: "Move 1 selected photo to Trash" }));
  const dialog = screen.getByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Move selected to Trash" }));
  await within(dialog).findByRole("alert");
  expect(screen.getByText("1 selected")).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Refresh rejected photos" }));
  await screen.findByText("1 rejected photo");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("1 selected")).toBeNull();
  expect(api.bulkUpdatePhotos).toHaveBeenCalledTimes(1);
});

test("empty review takes precedence over an empty archive and narrowed results have accurate wording", async () => {
  photos = [];
  const view = render(<Home />);
  await screen.findByRole("heading", { name: "No rejected photos need cleanup" });
  expect(screen.queryByText("Start your animal archive")).toBeNull();
  view.unmount();
  photos = [photo(1)];
  window.history.replaceState(null, "", "/?catalog_culling_state=reject&catalog_search=missing");
  render(<Home />);
  await screen.findByRole("heading", { name: "No rejected photos match these filters" });
  expect(screen.getByText("0 rejected photos matching current filters")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Review all rejected photos" }).getAttribute("href")).toBe(REJECTED_PHOTOS_HREF);
});

test("cross-page Compare retains the rejected query and Pick is reflected after return", async () => {
  paginated = true;
  const list = render(<Home />);
  await screen.findByRole("heading", { name: "Fox 1" });
  await select();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Compare" }).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("heading", { name: "Fox 2" });
  await userEvent.click(screen.getByRole("checkbox", { name: "Select photo 2: Fox 2" }));
  expect(screen.getByText("2 selected · 1 on this page")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Compare" }));
  const returnTo = new URLSearchParams(window.location.search).get("returnTo")!;
  expect(returnTo).toContain("catalog_culling_state=reject");
  expect(returnTo).toContain("catalog_page=2");
  list.unmount();
  const compare = render(<CompareBrowser />);
  await screen.findByRole("button", { name: "Pick left photo" });
  await userEvent.click(screen.getByRole("button", { name: "Pick left photo" }));
  await waitFor(() => expect(api.updatePhoto).toHaveBeenCalledWith(1, { culling_state: "pick" }, expect.any(String)));
  await waitFor(() => expect(screen.getByRole("button", { name: "Pick left photo", pressed: true })).toBeTruthy());
  expect(screen.getByRole("link", { name: "Back to List" }).getAttribute("href")).toBe(returnTo);
  compare.unmount();
  window.history.replaceState(null, "", returnTo);
  render(<Home />);
  await screen.findByText("1 rejected photo");
  expect(screen.queryByRole("heading", { name: "Fox 1" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Fox 2" })).toBeTruthy();
  expect(screen.queryByText(/2 selected/)).toBeNull();
  expect(window.location.search).not.toContain("catalog_page");
});

test("entry clears source and editing criteria and filter/history changes enter and exit review", async () => {
  window.history.replaceState(null, "", "/?catalog_search=Fox&catalog_favorites_only=1&catalog_sort=rating&catalog_layout=grouped");
  render(<Home />);
  await screen.findByRole("heading", { name: "Fox 1" });
  expect(screen.getByRole("link", { name: "Review rejected" }).getAttribute("href")).toBe(REJECTED_PHOTOS_HREF);
  await act(async () => { window.history.pushState(null, "", REJECTED_PHOTOS_HREF); window.dispatchEvent(new PopStateEvent("popstate")); });
  await screen.findByText("2 rejected photos");
  await userEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Rejected Photos" })).toBeNull());
  await act(async () => { window.history.pushState(null, "", REJECTED_PHOTOS_HREF); window.dispatchEvent(new PopStateEvent("popstate")); });
  await screen.findByText("2 rejected photos");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Culling filter" }), "pick");
  await screen.findByRole("heading", { name: "Fox 3" });
  expect(screen.queryByRole("heading", { name: "Rejected Photos" })).toBeNull();
});
