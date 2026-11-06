import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SightingFormDialog from "../app/components/sightings/sighting-form-dialog";
import PhotoDetail from "../app/photos/[id]/photo-detail";
import SightingDetail from "../app/sightings/[id]/sighting-detail";
import SightingJournal from "../app/sightings/sighting-journal";
import type { Photo, Sighting, SightingJournalPage, SightingTaxon } from "../app/lib/api";
import { useState } from "react";

const api = vi.hoisted(() => ({
  changeSightingPhotos: vi.fn(), createSighting: vi.fn(), deleteSighting: vi.fn(),
  getSighting: vi.fn(), getSightingPhotos: vi.fn(), getSightings: vi.fn(),
  getSightingSelection: vi.fn(), getSightingTaxa: vi.fn(), updateSighting: vi.fn(),
  getPhoto: vi.fn(), getPhotoSightings: vi.fn(), getNearbyPhotos: vi.fn(),
  getClassificationJobs: vi.fn(),
}));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));
vi.mock("../app/components/maps/map-boundaries", () => ({
  PhotoLocationMap: ({ latitude, longitude }: { latitude: number; longitude: number }) => <div role="region" aria-label={`Map at ${latitude}, ${longitude}`} />,
}));

const observed = "2026-08-23T19:30:05.123456";
const photoIds = [11, 12];
const fox: SightingTaxon = {
  id: 5, common_name: "Red fox", canonical_name: "Vulpes vulpes", scientific_name: "Vulpes vulpes",
  taxonomic_rank: "SPECIES", provider: "gbif", external_taxon_id: "1",
};
const photo: Photo = {
  id: 11, original_filename: "encounter.jpg", stored_filename: "original.jpg", resized_filename: "resized.jpg",
  thumbnail_filename: "thumb.jpg", display_title: "Meadow photo", common_name: null, species_guess: null,
  breed_guess: null, category: null, confidence: null, description: null, tags: [], status: "pending",
  animal_id: null, content_sha256: null, original_size_bytes: null, media_type: "image/jpeg",
  is_favorite: false, rating: null, culling_state: null, extracted_captured_at: null,
  extracted_captured_at_offset_minutes: null, extracted_latitude: null, extracted_longitude: null,
  capture_metadata_overridden: false, location_metadata_overridden: false, captured_at: null,
  captured_at_offset_minutes: null, latitude: null, longitude: null, camera_make: null,
  camera_model: null, lens_model: null, image_width: null, image_height: null,
  deleted_at: null, reviewed_at: null, created_at: observed, updated_at: observed,
};
const preview = { id: photo.id, original_filename: photo.original_filename, thumbnail_filename: photo.thumbnail_filename, display_title: photo.display_title };
const item: Sighting = {
  id: 7, subject_label: "Fox by the meadow", taxon_id: 5, taxon: fox, observed_at: observed,
  observed_at_offset_minutes: 120, latitude: 0, longitude: 0, location_label: "North meadow",
  notes: "First note", created_at: observed, updated_at: observed, active_photo_count: 1,
  trash_photo_count: 1, preview,
};
const page = <T,>(items: T[], currentPage = 1, total = items.length, pages = items.length ? 1 : 0) => ({
  items, page: currentPage, total, page_size: 24, total_pages: pages,
});
function journal(items = [item], currentPage = 1, total = items.length, pages = 1): SightingJournalPage {
  return { ...page(items, currentPage, total, pages), totals: { recorded: total, in_date_range: total, verified: total, unidentified: 0 } };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/");
  api.getSightings.mockResolvedValue(journal());
  api.getSighting.mockResolvedValue(item);
  api.getSightingPhotos.mockResolvedValue(page([photo]));
  api.getSightingTaxa.mockResolvedValue({ items: [fox], has_more: false });
  api.getSightingSelection.mockResolvedValue({
    photo_count: 2, previews: [preview], observed_at: null, observed_at_offset_minutes: null,
    latitude: null, longitude: null, capture_times_differ: true,
  });
  api.createSighting.mockResolvedValue(item);
  api.updateSighting.mockResolvedValue({ ...item, notes: "Updated note" });
  api.changeSightingPhotos.mockResolvedValue({ ...item, active_photo_count: 0, preview: null });
  api.deleteSighting.mockResolvedValue({ status: "deleted", sighting_id: 7 });
  api.getPhoto.mockResolvedValue(photo);
  api.getNearbyPhotos.mockResolvedValue({ source_photo_id: 11, radius_km: 5, availability: "unavailable", unavailable_reason: "missing_gps", total: 0, items: [] });
  api.getClassificationJobs.mockResolvedValue({ jobs: [], summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 } });
  api.getPhotoSightings.mockResolvedValue(page([item]));
});
afterEach(cleanup);

test("journal shows encounter totals, card links, pagination, sorting and filters", async () => {
  const user = userEvent.setup();
  api.getSightings.mockImplementation(async (filters) => journal(
    filters.page === 1 ? [item] : [{ ...item, id: 8, subject_label: "Second encounter" }],
    filters.page, 2, 2,
  ));
  render(<SightingJournal />);
  const card = await screen.findByRole("link", { name: /Fox by the meadow/ });
  expect(card.getAttribute("href")).toBe("/sightings/7");
  expect(card.textContent).toContain("1 active photo");
  expect(within(card).getByRole("img", { name: "Meadow photo" })).toBeTruthy();
  expect(screen.getByLabelText("Journal totals").textContent).toContain("Total recorded2");
  await user.click(within(screen.getByRole("navigation", { name: "Sighting journal pages" })).getByRole("button", { name: "Next" }));
  expect(await screen.findByRole("link", { name: /Second encounter/ })).toBeTruthy();
  await user.selectOptions(screen.getByLabelText("Sort sightings"), "oldest");
  await screen.findByRole("link", { name: /Fox by the meadow/ });
  expect(api.getSightings).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "oldest", page: 1 }), expect.any(AbortSignal));
  fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-08-23" } });
  fireEvent.change(screen.getByLabelText("Through date"), { target: { value: "2026-08-22" } });
  expect(screen.getByRole("alert").textContent).toMatch(/From date/);
  fireEvent.change(screen.getByLabelText("Through date"), { target: { value: "2026-08-24" } });
  await user.click(screen.getByRole("button", { name: "Apply dates" }));
  await user.click(screen.getByRole("button", { name: "Choose species" }));
  await user.type(screen.getByLabelText("Search local species"), "fox");
  await user.click(await screen.findByRole("button", { name: /Red fox/ }));
  expect(api.getSightingTaxa).toHaveBeenLastCalledWith("fox", 1, expect.any(AbortSignal));
  expect(api.getSightings).toHaveBeenLastCalledWith({ page: 1, sort: "oldest", taxon_id: 5, date_from: "2026-08-23", date_to: "2026-08-24" }, expect.any(AbortSignal));
});

test("journal moves from loading to error to empty when retried", async () => {
  api.getSightings.mockRejectedValueOnce(new Error("Archive unavailable")).mockResolvedValueOnce(journal([], 1, 0, 0));
  render(<SightingJournal />);
  expect(screen.getByRole("status").textContent).toBe("Loading sightings…");
  expect((await screen.findByRole("alert")).textContent).toContain("Archive unavailable");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "No sightings recorded yet" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open List" }).getAttribute("href")).toBe("/");
});

test("creation previews explicit photos, requires a date for conflicting captures, validates GPS and links a local species", async () => {
  const user = userEvent.setup();
  const onSaved = vi.fn();
  render(<SightingFormDialog photoIds={photoIds} onClose={vi.fn()} onSaved={onSaved} />);
  const dialog = within(screen.getByRole("dialog", { name: "Create Sighting" }));
  expect(await dialog.findByRole("img", { name: "Meadow photo" })).toBeTruthy();
  expect(dialog.getByText(/different capture times/)).toBeTruthy();
  const date = dialog.getByLabelText(/Observation date and time/) as HTMLInputElement;
  expect(date.value).toBe("");
  expect(date.validity.valueMissing).toBe(true);
  await user.click(dialog.getByRole("button", { name: "Save Sighting" }));
  expect(api.createSighting).not.toHaveBeenCalled();
  fireEvent.change(date, { target: { value: "2026-08-23T19:30" } });
  await user.type(dialog.getByLabelText(/Latitude/), "0");
  await user.click(dialog.getByRole("button", { name: "Save Sighting" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("Enter both latitude and longitude");
  await user.type(dialog.getByLabelText(/Longitude/), "0");
  await user.click(dialog.getByRole("button", { name: "Choose species" }));
  await user.click(await dialog.findByRole("button", { name: /Red fox/ }));
  expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Choose species" }));
  await user.click(dialog.getByRole("button", { name: "Save Sighting" }));
  expect(api.createSighting).toHaveBeenCalledWith(expect.objectContaining({
    observed_at: "2026-08-23T19:30:00", taxon_id: 5, latitude: 0, longitude: 0,
  }), photoIds);
  expect(onSaved).toHaveBeenCalledWith(item);
});

test("creation dialog traps keyboard focus and Escape returns focus to its trigger", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open form</button>
      {open && <SightingFormDialog photoIds={photoIds} onClose={() => setOpen(false)} onSaved={vi.fn()} />}</>;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Open form" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await screen.findByLabelText(/Subject label/);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Create Sighting" }));
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save Sighting" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByLabelText(/Subject label/));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("detail renders membership and zero coordinates, preserves precision on edit, and confirms removal and deletion", async () => {
  const user = userEvent.setup();
  render(<SightingDetail id={7} />);
  const gallery = await screen.findByRole("region", { name: "Linked photos" });
  expect(within(gallery).getByText("1 active · 1 in Trash")).toBeTruthy();
  expect((await within(gallery).findByRole("link", { name: /^Meadow photo$/ })).getAttribute("href")).toBe("/photos/11?returnTo=%2Fsightings%2F7");
  expect(screen.getByRole("link", { name: "Add existing photos" }).getAttribute("href")).toBe("/?add_to_sighting=7");
  expect(screen.getByRole("region", { name: "Map at 0, 0" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Edit Sighting" }));
  const edit = within(screen.getByRole("dialog", { name: "Edit Sighting" }));
  await user.clear(edit.getByLabelText(/Field notes/));
  await user.type(edit.getByLabelText(/Field notes/), "Updated note");
  await user.click(edit.getByRole("button", { name: "Save Sighting" }));
  expect(await screen.findByText("Updated note")).toBeTruthy();
  expect(api.updateSighting).toHaveBeenCalledWith(7, expect.objectContaining({ observed_at: observed, notes: "Updated note" }));
  api.getSightingPhotos.mockResolvedValueOnce(page([]));
  await user.click(within(gallery).getByRole("button", { name: /Remove encounter.jpg/ }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove photo" }));
  expect(await within(gallery).findByText("No active photos linked to this sighting.")).toBeTruthy();
  expect(api.changeSightingPhotos).toHaveBeenCalledWith(7, [11], "remove");
  await user.click(screen.getByRole("button", { name: "Delete Sighting" }));
  const confirmation = within(screen.getByRole("dialog", { name: "Delete Sighting?" }));
  expect(document.activeElement).toBe(confirmation.getByRole("button", { name: "Cancel" }));
  await user.keyboard("{Escape}");
  expect(api.deleteSighting).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Delete Sighting" }));
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Sighting" }));
  await waitFor(() => expect(window.location.pathname).toBe("/sightings"));
  expect(api.deleteSighting).toHaveBeenCalledWith(7);
});

test("Photo detail shows encounter links and supports retry independently of photo loading", async () => {
  api.getPhotoSightings.mockRejectedValueOnce(new Error("Sightings unavailable"));
  render(<PhotoDetail id="11" returnTo="/sightings/7" />);
  const sightings = within(await screen.findByRole("region", { name: /^Sightings$/ }));
  expect((await sightings.findByRole("alert")).textContent).toContain("Sightings unavailable");
  await userEvent.click(sightings.getByRole("button", { name: "Retry" }));
  expect((await sightings.findByRole("link", { name: /Fox by the meadow/ })).getAttribute("href")).toBe("/sightings/7");
  expect(screen.getByRole("link", { name: "Back to sighting" }).getAttribute("href")).toBe("/sightings/7");
});
