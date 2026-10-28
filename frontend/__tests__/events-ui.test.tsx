import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import EventsBrowser from "../app/events/events-browser";
import EventDetail from "../app/events/[id]/event-detail";
import EventListContext from "../app/components/events/event-list-context";
import AddToEventDialog from "../app/components/events/add-to-event-dialog";
import type { ArchiveEventDetail, ArchiveEventPage, Photo } from "../app/lib/api";
import { eventAddHref, eventCullHref, eventDateHref, eventMapHref } from "../app/lib/events";
import { parseCatalogState, DEFAULT_CATALOG_STATE, mapCatalogQuery, writeCatalogState } from "../app/lib/catalog-query";
import { savedQueryFromState } from "../app/lib/smart-collections";
import { compareReturnLocation } from "../app/lib/photo-compare";

const api = vi.hoisted(() => ({ getEvents: vi.fn(), getEvent: vi.fn(), updateEventCover: vi.fn(), createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvent: vi.fn(), addEventPhotos: vi.fn(), removeEventPhotos: vi.fn(), getCatalogPhotos: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));
const now = "2026-10-01T08:00:00Z";
function event(overrides: Partial<ArchiveEventDetail> = {}): ArchiveEventDetail {
  return { id: 7, cover_photo_id: null, cover_photo: null, previews: [], kind: "trip", title: "Valencia", start_date: "2026-08-12", end_date: "2026-08-17", location_label: "Spain", notes: "First line\n<script>plain text</script>", created_at: now, updated_at: now, active_photo_count: 2, trash_photo_count: 1, undecided_count: 1, pick_count: 1, reject_count: 0, ...overrides };
}
function page(items = [event()], overrides: Partial<ArchiveEventPage> = {}): ArchiveEventPage {
  return { items: items.map((item) => ({ ...item, previews: [] })), total: items.length, page: 1, page_size: 24, total_pages: items.length ? 1 : 0, ...overrides };
}
function photo(id: number): Photo {
  return { id, original_filename: `event-${id}.jpg`, stored_filename: `${id}.jpg`, resized_filename: `${id}.jpg`, thumbnail_filename: `${id}.jpg`, display_title: `Photo ${id}`, common_name: null, species_guess: null, breed_guess: null, category: null, confidence: null, description: null, tags: [], status: "pending", animal_id: null, content_sha256: null, original_size_bytes: null, media_type: "image/jpeg", is_favorite: false, rating: null, culling_state: null, extracted_captured_at: null, extracted_captured_at_offset_minutes: null, extracted_latitude: null, extracted_longitude: null, capture_metadata_overridden: false, location_metadata_overridden: false, captured_at: null, captured_at_offset_minutes: null, latitude: null, longitude: null, camera_make: null, camera_model: null, lens_model: null, image_width: null, image_height: null, deleted_at: null, reviewed_at: null, created_at: now, updated_at: now };
}
beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/events");
  api.getEvents.mockResolvedValue(page()); api.getEvent.mockResolvedValue(event());
  api.createEvent.mockResolvedValue(event({ id: 8 })); api.updateEvent.mockResolvedValue(event({ title: "Edited" }));
  api.deleteEvent.mockResolvedValue({ status: "deleted", event_id: 7 });
  api.addEventPhotos.mockResolvedValue({ event_id: 7, requested_count: 2, added_count: 1, already_present_count: 1 });
  api.removeEventPhotos.mockResolvedValue({ event_id: 7, requested_count: 1, removed_count: 1, already_absent_count: 0 });
  api.getCatalogPhotos.mockImplementation(async (query) => ({ items: [photo(11), photo(12)], total: 2, page: query.page, page_size: 48, total_pages: 1, facets: { active_total: 2, status_counts: { pending: 2, classified: 0, needs_review: 0 }, categories: [], uncategorized_count: 2 } }));
});

test("index restores kind/page, ignores stale responses, and supports Back/Forward", async () => {
  let resolveOld!: (value: ArchiveEventPage) => void;
  api.getEvents.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  render(<EventsBrowser />);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Trip/Event type filter" }), "event");
  expect(await screen.findByRole("heading", { name: "Valencia" })).toBeTruthy();
  expect(window.location.search).toBe("?kind=event");
  await act(async () => resolveOld(page([event({ title: "Stale" })])));
  expect(screen.queryByRole("heading", { name: "Stale" })).toBeNull();
  act(() => { window.history.replaceState(null, "", "/events?kind=trip&page=2"); window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(api.getEvents).toHaveBeenCalledWith(2, "trip", expect.any(AbortSignal)));
  expect(within(screen.getByRole("navigation", { name: "Archive views" })).getAllByRole("link")).toHaveLength(13);
});

test("index empty and API failure states retry", async () => {
  api.getEvents.mockRejectedValueOnce(new Error("Offline"));
  api.getEvents.mockResolvedValueOnce(page([]));
  render(<EventsBrowser />);
  expect((await screen.findByRole("alert")).textContent).toContain("Offline");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "No Trips & Events yet" })).toBeTruthy();
});

test("create defaults to Trip with blank dates and retains errors without duplicate saves", async () => {
  api.createEvent.mockRejectedValueOnce(new Error("Save failed"));
  render(<EventsBrowser />);
  await screen.findByRole("heading", { name: "Valencia" });
  await userEvent.click(screen.getByRole("button", { name: "Create Trip/Event" }));
  const dialog = screen.getByRole("dialog");
  expect((within(dialog).getByLabelText("Type") as HTMLSelectElement).value).toBe("trip");
  expect((within(dialog).getByLabelText("Start date") as HTMLInputElement).value).toBe("");
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("Title")));
  await userEvent.type(within(dialog).getByLabelText("Title"), "Valencia");
  fireEvent.change(within(dialog).getByLabelText("Start date"), { target: { value: "2026-08-12" } });
  fireEvent.change(within(dialog).getByLabelText("End date"), { target: { value: "2026-08-17" } });
  await userEvent.click(within(dialog).getByRole("button", { name: "Create Trip/Event" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Save failed");
  await userEvent.click(within(dialog).getByRole("button", { name: "Create Trip/Event" }));
  await waitFor(() => expect(window.location.pathname).toBe("/events/8"));
});

test("detail reuses scoped catalog, renders plain notes and metadata-only editing", async () => {
  render(<EventDetail eventId={7} />);
  await screen.findByRole("heading", { name: "Photo 11" });
  expect(api.getCatalogPhotos).toHaveBeenCalledWith(expect.objectContaining({ event_id: 7, page: 1, page_size: 48, sort: "created_at", order: "desc" }), expect.any(AbortSignal));
  expect(screen.getByText(/2 active Photos/).textContent).toContain("1 picked");
  expect(screen.getByText(/<script>plain text/).querySelector("script")).toBeNull();
  expect(screen.getByRole("link", { name: "Add suggested photos" }).getAttribute("href")).toBe(eventAddHref(event(), true));
  await userEvent.click(screen.getByRole("button", { name: "Edit Trip/Event" }));
  const dialog = screen.getByRole("dialog");
  await userEvent.clear(within(dialog).getByLabelText("Title"));
  await userEvent.type(within(dialog).getByLabelText("Title"), "Edited");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("heading", { name: "Edited" })).toBeTruthy();
  expect(api.updateEvent.mock.calls[0][1]).not.toHaveProperty("active_photo_count");
});

test("removal confirms membership only with Cancel focused; Compare returns to numeric Event", async () => {
  render(<EventDetail eventId={7} />);
  await screen.findByRole("heading", { name: "Photo 11" });
  await userEvent.click(screen.getAllByRole("button", { name: "Remove from Trip" })[0]);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Photos remain in FaunaVault/)).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
  await userEvent.click(within(dialog).getByRole("button", { name: "Remove memberships" }));
  await waitFor(() => expect(api.removeEventPhotos).toHaveBeenCalledWith(7, [11]));
  await screen.findByRole("heading", { name: "Photo 11" });
  await userEvent.click(screen.getByRole("button", { name: "Select photos" }));
  for (const checkbox of screen.getAllByRole("checkbox")) await userEvent.click(checkbox);
  await userEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(window.location.search).toContain("returnTo=%2Fevents%2F7");
});

test("delete keeps failure in dialog and explicitly preserves Photos", async () => {
  api.deleteEvent.mockRejectedValueOnce(new Error("Delete failed"));
  render(<EventDetail eventId={7} />);
  await screen.findByRole("heading", { name: "Valencia" });
  await userEvent.click(screen.getByRole("button", { name: "Delete Trip/Event" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Photos remain in FaunaVault/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Delete Trip/Event" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Delete failed");
});

test("all-in-Trash detail has clear empty state and deleted detail offers retry/navigation", async () => {
  api.getEvent.mockResolvedValueOnce(event({ active_photo_count: 0 }));
  api.getCatalogPhotos.mockResolvedValueOnce({ items: [], total: 0, total_pages: 0, page: 1, page_size: 48 });
  const view = render(<EventDetail eventId={7} />);
  expect(await screen.findByRole("heading", { name: "All member Photos are in Trash" })).toBeTruthy();
  view.unmount(); api.getEvent.mockRejectedValueOnce(new Error("Event no longer exists"));
  render(<EventDetail eventId={7} />);
  expect(await screen.findByRole("heading", { name: "Trip/Event unavailable" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to Trips & Events" }).getAttribute("href")).toBe("/events");
});

test("List addition is explicit, idempotent, retains errors, and refreshes current dates on demand", async () => {
  const added = vi.fn(), dates = vi.fn();
  api.addEventPhotos.mockRejectedValueOnce(new Error("Photo moved to Trash"));
  render(<EventListContext id="7" adding selectedIds={new Set([12, 11])} onAdded={added} onDates={dates} />);
  await screen.findByRole("heading", { name: "Add Photos to Trip: Valencia" });
  expect(api.addEventPhotos).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Use current Trip/Event dates" }));
  expect(dates).toHaveBeenCalledWith("2026-08-12", "2026-08-17");
  await userEvent.click(screen.getByRole("button", { name: "Add selected to this Trip" }));
  expect(api.addEventPhotos).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm add photos" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Photo moved to Trash");
  expect(added).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Confirm add photos" }));
  expect(api.addEventPhotos).toHaveBeenLastCalledWith(7, [11, 12]);
  expect(added).toHaveBeenCalledWith(expect.stringContaining("1 already present"));
});

test("invalid/deleted addition targets cannot add", async () => {
  const view = render(<EventListContext id="invalid" adding selectedIds={new Set([11])} />);
  expect((await screen.findByRole("alert")).textContent).toContain("unavailable");
  expect(api.getEvent).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Add selected to this Trip" })).toBeNull();
  view.unmount(); api.getEvent.mockRejectedValueOnce(new Error("Not found"));
  render(<EventListContext id="99" adding selectedIds={new Set([11])} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Not found");
});

test("membership confirmation cancels safely, snapshots IDs, and blocks duplicate submissions", async () => {
  let resolve!: (value: unknown) => void;
  api.addEventPhotos.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const view = render(<EventListContext id="7" adding selectedIds={new Set([11])} />);
  await screen.findByRole("heading", { name: "Add Photos to Trip: Valencia" });
  await userEvent.click(screen.getByRole("button", { name: "Add selected to this Trip" }));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.addEventPhotos).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Add selected to this Trip" }));
  view.rerender(<EventListContext id="7" adding selectedIds={new Set([12])} />);
  await userEvent.dblClick(screen.getByRole("button", { name: "Confirm add photos" }));
  expect(api.addEventPhotos).toHaveBeenCalledExactlyOnceWith(7, [11]);
  await userEvent.keyboard("{Escape}"); expect(screen.getByRole("dialog")).toBeTruthy();
  api.getEvent.mockRejectedValueOnce(new Error("Refresh failed"));
  await act(async () => resolve({ added_count: 1, already_present_count: 0 }));
  expect(await screen.findByRole("link", { name: "Open Trip/Event" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Added 1 Photos");
  expect((await screen.findByRole("alert")).textContent).toContain("Refresh failed");
  expect(api.addEventPhotos).toHaveBeenCalledTimes(1);
});

test("List target enforces the existing 250-photo operation limit", async () => {
  render(<EventListContext id="7" adding selectedIds={new Set(Array.from({ length: 251 }, (_, index) => index + 1))} />);
  await screen.findByRole("heading", { name: "Add Photos to Trip: Valencia" });
  expect((screen.getByRole("button", { name: "Add selected to this Trip" }) as HTMLButtonElement).disabled).toBe(true);
});

test("target choice paginates and clears a previous target before submitting", async () => {
  api.getEvents.mockResolvedValueOnce(page([event()], { total: 25, total_pages: 2 }));
  api.getEvents.mockResolvedValueOnce(page([event({ id: 8, title: "Forest" })], { page: 2, total: 25, total_pages: 2 }));
  const success = vi.fn();
  render(<AddToEventDialog photoIds={[11, 12]} onClose={vi.fn()} onSuccess={success} />);
  await userEvent.click(await screen.findByRole("radio", { name: /Valencia/ }));
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByRole("radio", { name: /Forest/ });
  expect((screen.getByRole("button", { name: "Add to Trip/Event" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("radio", { name: /Forest/ }));
  await userEvent.click(screen.getByRole("button", { name: "Add to Trip/Event" }));
  expect(api.addEventPhotos).toHaveBeenCalledWith(8, [11, 12]);
  expect(success).toHaveBeenCalled();
});

test("copied suggestion URLs expose dates; Event scope composes with Map/Culling and rejects Smart saving", () => {
  const suggestion = new URL(eventAddHref(event(), true), "http://localhost");
  const state = parseCatalogState(suggestion.searchParams);
  expect(state).toMatchObject({ taken_from: "2026-08-12", taken_to: "2026-08-17" });
  expect(state.event_id).toBeUndefined();
  const scoped = { ...DEFAULT_CATALOG_STATE, event_id: 7 };
  expect(writeCatalogState(new URLSearchParams(), scoped).get("catalog_event_id")).toBe("7");
  expect(mapCatalogQuery(scoped)).toMatchObject({ event_id: 7 });
  expect(eventMapHref(7)).toContain("catalog_event_id=7");
  expect(eventCullHref(7)).toContain("catalog_event_id=7");
  expect(eventDateHref(event())).not.toContain("event_id");
  expect(() => savedQueryFromState(scoped, "")).toThrow(/Event/);
  expect(parseCatalogState(new URLSearchParams("catalog_event_id=bad")).event_id).toBe(0);
  expect(compareReturnLocation("/events/7?page=2")).toBe("/events/7?page=2");
  expect(compareReturnLocation("/events/deleted")).toBe("/");
});

const cover = { id: 11, original_filename: "cover.jpg", display_title: "Chosen cover", thumbnail_filename: "cover-thumb.jpg" };

test("cover saves immediately, announces success, blocks duplicate submissions and preserves page", async () => {
  let resolve!: (value: ArchiveEventDetail) => void;
  api.updateEventCover.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  window.history.replaceState(null, "", "/events/7?page=2");
  api.getCatalogPhotos.mockResolvedValue({ items: [photo(11), photo(12)], total: 50, page: 2, page_size: 48, total_pages: 2 });
  render(<EventDetail eventId={7} />);
  const set = await screen.findByRole("button", { name: "Set as cover: Photo 11" });
  expect(set.getAttribute("aria-pressed")).toBe("false");
  await userEvent.dblClick(set);
  expect(api.updateEventCover).toHaveBeenCalledExactlyOnceWith(7, 11);
  expect((set as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getAllByRole("button", { name: "Remove from Trip" })[0] as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve(event({ cover_photo_id: 11, cover_photo: cover })));
  const current = screen.getByRole("button", { name: "Current cover: Photo 11" });
  expect(current.getAttribute("aria-pressed")).toBe("true");
  expect((current as HTMLButtonElement).disabled).toBe(true);
  expect(within(screen.getByRole("region", { name: "Trip/Event cover" })).getByRole("img").getAttribute("src")).toContain("cover-thumb.jpg");
  expect(screen.getByRole("status").textContent).toBe("Custom cover saved.");
  expect(window.location.search).toBe("?page=2");
  expect(api.removeEventPhotos).not.toHaveBeenCalled();
});

test("remove custom cover restores the API fallback and has a pending disabled state", async () => {
  api.getEvent.mockResolvedValue(event({ cover_photo_id: 11, cover_photo: cover }));
  let resolve!: (value: ArchiveEventDetail) => void;
  api.updateEventCover.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<EventDetail eventId={7} />);
  const remove = await screen.findByRole("button", { name: "Remove custom cover" });
  await userEvent.dblClick(remove);
  expect(api.updateEventCover).toHaveBeenCalledExactlyOnceWith(7, null);
  expect((remove as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve(event({ cover_photo_id: null, cover_photo: { ...cover, id: 12, display_title: "Automatic fallback" } })));
  expect(screen.getByText("Automatic cover")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Trip/Event cover" })).getByRole("img", { name: "Automatic fallback" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("Automatic cover restored");
  expect((screen.getByRole("button", { name: "Remove custom cover" }) as HTMLButtonElement).disabled).toBe(true);
});

test("cover conflict displays accessible feedback, refreshes stale membership, and permits retry", async () => {
  api.updateEventCover.mockRejectedValueOnce(new Error("Cover must be a member Photo. Refresh the Trip/Event."));
  api.updateEventCover.mockResolvedValueOnce(event({ cover_photo_id: 12, cover_photo: { ...cover, id: 12 } }));
  render(<EventDetail eventId={7} />);
  await userEvent.click(await screen.findByRole("button", { name: "Set as cover: Photo 11" }));
  expect((await screen.findByRole("alert")).textContent).toContain("member Photo");
  await waitFor(() => expect(api.getEvent).toHaveBeenCalledTimes(2));
  await userEvent.click(await screen.findByRole("button", { name: "Set as cover: Photo 12" }));
  expect(await screen.findByRole("button", { name: "Current cover: Photo 12" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("membership selection hides cover actions, leaving them separate from membership removal", async () => {
  render(<EventDetail eventId={7} />);
  await userEvent.click(await screen.findByRole("button", { name: "Select photos" }));
  expect(screen.queryByRole("button", { name: "Set as cover: Photo 11" })).toBeNull();
  await userEvent.click(screen.getAllByRole("checkbox")[0]);
  expect(api.updateEventCover).not.toHaveBeenCalled();
});

test("index displays the selected cover prominently with a wide thumbnail and empty placeholder", async () => {
  api.getEvents.mockResolvedValue({ ...page(), items: [event({ cover_photo_id: 11, cover_photo: cover }), event({ id: 8, title: "Empty event", active_photo_count: 0 })] });
  render(<EventsBrowser />);
  const image = await screen.findByRole("img", { name: "Chosen cover" });
  expect(image.getAttribute("src")).toContain("/images/thumbs/cover-thumb.jpg");
  expect(image.parentElement?.className).toContain("aspect-[16/9]");
  expect(screen.getByText("No active Photos for a cover")).toBeTruthy();
  fireEvent.error(image);
  expect(screen.getByText("Image unavailable")).toBeTruthy();
});

test("detail explains retained Trash covers, supports responsive header, and updates the preview after a change", async () => {
  api.getEvent.mockResolvedValue(event({ cover_photo_id: 99, cover_photo: cover }));
  api.updateEventCover.mockResolvedValue(event({ cover_photo_id: 12, cover_photo: { ...cover, id: 12, thumbnail_filename: "next-thumb.jpg" } }));
  render(<EventDetail eventId={7} />);
  expect(await screen.findByText(/Custom cover is in Trash/)).toBeTruthy();
  const header = screen.getByRole("region", { name: "Trip/Event cover" });
  const image = within(header).getByRole("img");
  expect(image.parentElement?.className).toContain("sm:aspect-[3/1]");
  fireEvent.error(image);
  expect(within(header).getByText("Image unavailable")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Set as cover: Photo 12" }));
  expect(within(header).getByRole("img").getAttribute("src")).toContain("next-thumb.jpg");
});
