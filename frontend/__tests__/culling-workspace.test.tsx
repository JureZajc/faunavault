import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import CullingBrowser from "../app/cull/culling-browser";
import PhotoCard from "../app/components/catalog/photo-card";
import { ApiError, CatalogQuery, CullingWorkspace, Photo, PhotoUpdate } from "../app/lib/api";
import { cullingListHref, DEFAULT_CATALOG_STATE, hasCurationFilters, mapListHref, parseCatalogState, writeCatalogState } from "../app/lib/catalog-query";
import { savedQueryFromState, smartCollectionCriteria, smartCollectionEditHref } from "../app/lib/smart-collections";

const api = vi.hoisted(() => ({ getCullingWorkspace: vi.fn(), updatePhoto: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));
vi.mock("../app/components/photo-detail/photo-media", () => ({ default: ({ photo }: { photo: Photo }) => <div>Preview {photo.id}</div> }));

function makePhoto(id: number): Photo {
  return {
    id, original_filename: `photo-${id}.jpg`, stored_filename: `${id}.jpg`, resized_filename: `${id}-resized.jpg`, thumbnail_filename: `${id}-thumb.jpg`,
    display_title: `Photo ${id}`, common_name: "fox", breed_guess: null, species_guess: "Vulpes vulpes", category: "bird",
    confidence: 0.4, description: "A fox", tags: [], status: "needs_review", animal_id: null,
    content_sha256: null, original_size_bytes: null, media_type: "image/jpeg", culling_state: null, is_favorite: true, rating: 5,
    extracted_captured_at: null, extracted_captured_at_offset_minutes: null, extracted_latitude: null, extracted_longitude: null,
    capture_metadata_overridden: false, location_metadata_overridden: false, captured_at: null, captured_at_offset_minutes: null,
    camera_make: null, camera_model: null, lens_model: null, image_width: null, image_height: null, latitude: null, longitude: null,
    deleted_at: null, reviewed_at: null, created_at: "2026-01-01T00:00:00", updated_at: "2026-01-01T00:00:00",
  };
}

let photos: Photo[];
function response(query: CatalogQuery, id?: number): CullingWorkspace {
  const matches = photos.filter((photo) => !query.category || photo.category === query.category).filter((photo) => !query.culling_state || (query.culling_state === "undecided" ? photo.culling_state === null : photo.culling_state === query.culling_state));
  const anchor = photos.find((photo) => photo.id === id && (!query.category || photo.category === query.category));
  const photo = anchor ?? matches[0] ?? null;
  const candidates = photos.filter((candidate) => matches.includes(candidate) || candidate.id === photo?.id);
  const position = candidates.findIndex((candidate) => candidate.id === photo?.id);
  return { photo: photo ? { ...photo } : null, total: matches.length, position: photo && matches.includes(photo) ? matches.indexOf(photo) + 1 : null,
    previous_photo_id: candidates[position - 1]?.id ?? null, next_photo_id: candidates[position + 1]?.id ?? null,
    matches_query: Boolean(photo && matches.includes(photo)), requested_photo_unavailable: id !== undefined && !anchor };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/cull?photo=3");
  photos = [makePhoto(3), makePhoto(2), makePhoto(1)];
  api.getCullingWorkspace.mockImplementation(async (query: CatalogQuery, id?: number) => response(query, id));
  api.updatePhoto.mockImplementation(async (id: number, values: PhotoUpdate) => {
    const index = photos.findIndex((photo) => photo.id === id);
    photos[index] = { ...photos[index], ...values, updated_at: new Date(Date.parse(photos[index].updated_at) + 1000).toISOString() };
    return { ...photos[index] };
  });
});

test("default queue auto-advances without losing previous saved decisions; clear stays and next follows history", async () => {
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  expect(api.getCullingWorkspace).toHaveBeenCalledWith(expect.objectContaining({ culling_state: "undecided" }), 3, expect.any(AbortSignal));
  await userEvent.click(screen.getByRole("button", { name: "Pick (P)" }));
  await screen.findByRole("heading", { name: "Photo 2" });
  expect(api.updatePhoto).toHaveBeenCalledWith(3, { culling_state: "pick" }, "2026-01-01T00:00:00");
  await userEvent.click(screen.getByRole("button", { name: "Reject (X)" }));
  await screen.findByRole("heading", { name: "Photo 1" });
  await userEvent.click(screen.getByRole("button", { name: /Previous/ }));
  await screen.findByRole("heading", { name: "Photo 2" });
  expect(screen.getByRole("button", { name: "Reject (X)", pressed: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Previous/ }));
  await screen.findByRole("heading", { name: "Photo 3" });
  await userEvent.click(screen.getByRole("button", { name: "Clear decision (U)" }));
  await waitFor(() => expect(screen.getByText("Saved: Undecided.")).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Photo 3" })).toBeTruthy();
  expect(screen.getByText(/1 decisions this session/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  await screen.findByRole("heading", { name: "Photo 2" });
  expect(screen.queryByText("Saved: Undecided.")).toBeNull();
  expect(photos[0].is_favorite && photos[0].rating === 5 && photos[0].status === "needs_review").toBe(true);
});

test("Compare uses the existing next neighbor, falls back to previous and disables for a single photo", async () => {
  const view = render(<CullingBrowser />);
  const next = await screen.findByRole("link", { name: "Compare with next" });
  expect(Object.fromEntries(new URL(next.getAttribute("href")!, "http://localhost").searchParams)).toEqual({ left: "3", right: "2", returnTo: "/cull?photo=3" });
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  await screen.findByRole("heading", { name: "Photo 2" });
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  const previous = await screen.findByRole("link", { name: "Compare with previous" });
  expect(Object.fromEntries(new URL(previous.getAttribute("href")!, "http://localhost").searchParams)).toEqual({ left: "1", right: "2", returnTo: "/cull?photo=1" });
  expect(api.updatePhoto).not.toHaveBeenCalled();
  view.unmount(); photos = [makePhoto(3)]; window.history.replaceState(null, "", "/cull?photo=3");
  render(<CullingBrowser />);
  expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Compare · no neighbor" })).disabled).toBe(true);
});

test("skipping leaves state alone and last save keeps image with end-of-pass and restart", async () => {
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByRole("heading", { name: "Photo 2" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  await screen.findByRole("heading", { name: "Photo 1" });
  fireEvent.keyDown(window, { key: "x" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Reject (X)", pressed: true })).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Photo 1" })).toBeTruthy();
  expect(screen.getByText(/End of pass · 2 still match/)).toBeTruthy();
  expect(api.updatePhoto).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  await screen.findByRole("heading", { name: "Photo 3" });
  expect(screen.getByText(/0 decisions this session/)).toBeTruthy();
});

test("shortcuts respect forms, modifiers, repeat, native arrows and modal isolation", async () => {
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  const input = document.createElement("input"); document.body.append(input);
  fireEvent.keyDown(input, { key: "p" }); input.remove();
  const editable = document.createElement("div"); editable.setAttribute("contenteditable", "true"); document.body.append(editable);
  fireEvent.keyDown(editable, { key: "x" }); editable.remove();
  for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { shiftKey: true }]) fireEvent.keyDown(window, { key: "p", ...options });
  fireEvent.keyDown(screen.getByRole("button", { name: /Next/ }), { key: "ArrowRight" });
  const modal = document.createElement("div"); modal.setAttribute("aria-modal", "true"); document.body.append(modal);
  fireEvent.keyDown(window, { key: "p" }); modal.remove();
  expect(api.updatePhoto).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Photo 3" })).toBeTruthy();
  fireEvent.keyDown(window, { key: "p" });
  await screen.findByRole("heading", { name: "Photo 2" });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  await screen.findByRole("heading", { name: "Photo 3" });
  fireEvent.keyDown(window, { key: "u" });
  await waitFor(() => expect(api.updatePhoto).toHaveBeenLastCalledWith(3, { culling_state: null }, expect.any(String)));
});

test("failed and pending saves retain confirmed state and block overlapping decisions/navigation", async () => {
  api.updatePhoto.mockRejectedValueOnce(new Error("offline"));
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  await userEvent.click(screen.getByRole("button", { name: "Pick (P)" }));
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
  expect(screen.getByRole("button", { name: "Pick (P)", pressed: false })).toBeTruthy();
  let finish!: (photo: Photo) => void;
  api.updatePhoto.mockImplementationOnce(() => new Promise<Photo>((resolve) => { finish = resolve; }));
  await userEvent.click(screen.getByRole("button", { name: "Reject (X)" }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: /Next/ }).disabled).toBe(true);
  fireEvent.keyDown(window, { key: "p" }); fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(api.updatePhoto).toHaveBeenCalledTimes(2);
  photos[0] = { ...photos[0], culling_state: "reject" }; finish(photos[0]);
  await screen.findByRole("heading", { name: "Photo 2" });
});

test("save success followed by refresh failure is distinguished and can refresh without resaving", async () => {
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  api.getCullingWorkspace.mockRejectedValueOnce(new Error("queue offline"));
  await userEvent.click(screen.getByRole("button", { name: "Pick (P)" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Decision saved, but the queue could not refresh");
  expect(screen.getByRole("button", { name: "Pick (P)", pressed: true })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Refresh / Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(api.updatePhoto).toHaveBeenCalledTimes(1);
});

test("failed decision has an explicit retry using the confirmed timestamp", async () => {
  api.updatePhoto.mockRejectedValueOnce(new Error("offline"));
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  await userEvent.click(screen.getByRole("button", { name: "Pick (P)" }));
  await userEvent.click(await screen.findByRole("button", { name: "Retry decision" }));
  await screen.findByRole("heading", { name: "Photo 2" });
  expect(api.updatePhoto).toHaveBeenCalledTimes(2);
  expect(api.updatePhoto).toHaveBeenLastCalledWith(3, { culling_state: "pick" }, makePhoto(3).updated_at);
});

test("a stale save refreshes confirmed state without automatically submitting another decision", async () => {
  api.updatePhoto.mockImplementationOnce(async () => { photos[0].culling_state = "reject"; throw new ApiError("Photo changed", 409, { code: "photo_changed" }); });
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  await userEvent.click(screen.getByRole("button", { name: "Pick (P)" }));
  await screen.findByRole("button", { name: "Reject (X)", pressed: true });
  expect(screen.getByRole("alert").textContent).toContain("Photo changed");
  expect(api.updatePhoto).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Retry decision" })).toBeNull();
});

test("empty source and load failure provide retry; unavailable requested photo falls back", async () => {
  photos = [];
  api.getCullingWorkspace.mockRejectedValueOnce(new Error("load offline"));
  render(<CullingBrowser />);
  expect((await screen.findByRole("alert")).textContent).toContain("load offline");
  await userEvent.click(screen.getByRole("button", { name: "Refresh / Retry" }));
  await screen.findByRole("heading", { name: "No photos to cull" });
  expect(screen.getByText(/no longer available/)).toBeTruthy();
});

test("List source preserves filters, sort, current URL and safe return; source change resets session history", async () => {
  window.history.replaceState(null, "", "/cull?source=list&catalog_favorites_only=1&catalog_rating=5&catalog_culling_state=pick&catalog_category=bird&catalog_sort=rating&returnTo=%2F%3Fcatalog_page%3D2");
  photos[0].culling_state = "pick";
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  expect(api.getCullingWorkspace).toHaveBeenCalledWith(expect.objectContaining({ culling_state: "pick", favorites_only: true, rating: 5, category: "bird", sort: "rating", page: 1 }), expect.anything(), expect.any(AbortSignal));
  expect(screen.getByRole("link", { name: "Back to List" }).getAttribute("href")).toBe("/?catalog_page=2");
  const detailReturn = new URL(screen.getByRole("link", { name: "Open Photo detail" }).getAttribute("href")!, "http://localhost").searchParams.get("returnTo");
  expect(detailReturn).toContain("/cull?source=list");
  await userEvent.click(screen.getByRole("button", { name: "Reject (X)" }));
  await waitFor(() => expect(screen.getByText(/1 decisions this session/)).toBeTruthy());
  window.history.pushState(null, "", "/cull?photo=2&returnTo=https%3A%2F%2Fevil.example"); window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Photo 2" });
  expect(screen.getByText(/0 decisions this session/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to List" }).getAttribute("href")).toBe("/");
});

test("a navigation load failure hides the previous photo and its actions until retry", async () => {
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  api.getCullingWorkspace.mockRejectedValueOnce(new Error("navigation offline"));
  await userEvent.click(screen.getByRole("button", { name: /Next/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("navigation offline");
  expect(screen.queryByRole("button", { name: "Pick (P)" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Refresh / Retry" }));
  await screen.findByRole("heading", { name: "Photo 2" });
});

test("late source response cannot replace the current photo", async () => {
  let finish!: (value: CullingWorkspace) => void;
  api.getCullingWorkspace.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<CullingBrowser />);
  await waitFor(() => expect(api.getCullingWorkspace).toHaveBeenCalledTimes(1));
  window.history.pushState(null, "", "/cull?photo=2"); window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Photo 2" });
  finish(response(DEFAULT_CATALOG_STATE, 3));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Photo 3" })).toBeNull());
});

test("cards show independent culling indicators without decision controls", () => {
  render(<><PhotoCard photo={{ ...makePhoto(1), culling_state: "pick" }} returnTo="/" /><PhotoCard photo={{ ...makePhoto(2), culling_state: "reject" }} returnTo="/" /></>);
  expect(screen.getByLabelText("Picked")).toBeTruthy();
  expect(screen.getByLabelText("Rejected")).toBeTruthy();
  expect(screen.getAllByLabelText("Favorite")).toHaveLength(2);
  expect(screen.getAllByLabelText("Rated 5 out of 5 stars")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Pick" })).toBeNull();
});

test("a late manual refresh error cannot overwrite the new source", async () => {
  api.getCullingWorkspace.mockRejectedValueOnce(new Error("initial offline"));
  render(<CullingBrowser />);
  await screen.findByRole("alert");
  let fail!: (reason: Error) => void;
  api.getCullingWorkspace.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  await userEvent.click(screen.getByRole("button", { name: "Refresh / Retry" }));
  window.history.pushState(null, "", "/cull?photo=2"); window.dispatchEvent(new PopStateEvent("popstate"));
  await screen.findByRole("heading", { name: "Photo 2" });
  fail(new Error("old refresh offline"));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a refresh started before a retried Clear cannot overwrite its saved decision", async () => {
  photos[0].culling_state = "pick";
  render(<CullingBrowser />);
  await screen.findByRole("heading", { name: "Photo 3" });
  api.updatePhoto.mockRejectedValueOnce(new Error("offline"));
  await userEvent.click(screen.getByRole("button", { name: "Clear decision (U)" }));
  const old = response({ ...DEFAULT_CATALOG_STATE, culling_state: "undecided" }, 3);
  let finish!: (value: CullingWorkspace) => void;
  api.getCullingWorkspace.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await userEvent.click(await screen.findByRole("button", { name: "Refresh / Retry" }));
  await userEvent.click(screen.getByRole("button", { name: "Retry decision" }));
  await screen.findByText("Saved: Undecided.");
  finish(old);
  await waitFor(() => expect(screen.getByRole("button", { name: "Pick (P)", pressed: false })).toBeTruthy());
  expect(screen.getByRole("heading", { name: "Photo 3" })).toBeTruthy();
});

test("shared URL and Smart Collection helpers preserve structured culling criteria", () => {
  for (const state of ["pick", "reject", "undecided"] as const) {
    const query = { ...DEFAULT_CATALOG_STATE, culling_state: state, favorites_only: true, rating_min: 4 as const, page: 3, layout: "grouped" as const };
    const params = writeCatalogState(new URLSearchParams(), query);
    expect(parseCatalogState(params)).toEqual(query);
    expect(hasCurationFilters(query)).toBe(true);
    expect(mapListHref(query)).toContain(`catalog_culling_state=${state}`);
    const href = cullingListHref(query, " fox ", "/?catalog_page=3");
    expect(href).toContain("source=list"); expect(href).not.toContain("catalog_page="); expect(href).not.toContain("catalog_layout=");
    const saved = savedQueryFromState(query, "fox");
    expect(saved.culling_state).toBe(state);
    expect(smartCollectionEditHref(7, saved)).toContain(`catalog_culling_state=${state}`);
    expect(smartCollectionCriteria(saved)).toContain("Culling:");
  }
  expect(parseCatalogState(new URLSearchParams("catalog_culling_state=trash")).culling_state).toBeUndefined();
});
