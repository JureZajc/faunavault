import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import PhotoDetail from "../app/photos/[id]/photo-detail";
import { Animal, Photo } from "../app/lib/api";
import { formatCameraLocalDate, parseCaptureFields, parseLocationFields } from "../app/lib/photo-metadata";

const api = vi.hoisted(() => ({
  getPhoto: vi.fn(),
  getAnimal: vi.fn(),
  getClassificationJobs: vi.fn(),
  updatePhoto: vi.fn(),
  mockClassifyPhoto: vi.fn(),
  classifyPhoto: vi.fn(),
  searchTaxonomy: vi.fn(),
  selectAnimalTaxon: vi.fn(),
  deletePhoto: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

vi.mock("../app/components/maps/map-boundaries", () => ({
  PhotoLocationMap: ({
    latitude,
    longitude,
    label,
  }: {
    latitude: number;
    longitude: number;
    label: string;
  }) => (
    <div
      role="region"
      aria-label={`Test map for ${label}`}
      data-latitude={latitude}
      data-longitude={longitude}
    />
  ),
  ArchivePhotoMap: () => null,
}));

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 44,
    original_filename: "lion.jpg",
    is_favorite: false, rating: null,
    stored_filename: "lion.jpg",
    resized_filename: "lion-resized.jpg",
    thumbnail_filename: "lion-thumb.jpg",
    display_title: "Lion",
    common_name: "lion",
    breed_guess: null,
    species_guess: "Panthera leo",
    category: "mammal",
    confidence: 0.91,
    description: "Adult lion",
    tags: ["wild", "cat"],
    status: "classified",
    animal_id: 12,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    extracted_captured_at: null, extracted_captured_at_offset_minutes: null,
    extracted_latitude: null, extracted_longitude: null,
    capture_metadata_overridden: false, location_metadata_overridden: false,
    captured_at: null, captured_at_offset_minutes: null,
    camera_make: null, camera_model: null, lens_model: null,
    image_width: null, image_height: null, latitude: null, longitude: null,
    deleted_at: null,
    reviewed_at: null,
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
    ...overrides,
  };
}

function animal(): Animal {
  return {
    id: 12,
    identifier: "FV-P000012",
    display_name: null,
    taxon_id: null,
    legacy_common_name: "lion",
    legacy_species_name: "Panthera leo",
    taxonomy_status: "unverified",
    taxonomy_note: null,
    created_at: "2026-08-12T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/photos/44");
  window.sessionStorage.clear();
  api.getPhoto.mockResolvedValue(photo());
  api.getAnimal.mockResolvedValue(animal());
  api.getClassificationJobs.mockResolvedValue({
    jobs: [],
    summary: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
  });
  api.updatePhoto.mockImplementation(async (_id: number, update: Partial<Photo>) =>
    photo({ ...update, updated_at: "2026-08-12T09:00:00Z" }),
  );
  api.searchTaxonomy.mockResolvedValue({
    results: [{
      provider: "gbif", external_taxon_id: 5219404, scientific_name: "Panthera leo (Linnaeus, 1758)",
      canonical_name: "Panthera leo", common_name: "Lion", rank: "SPECIES",
      kingdom: "Animalia", phylum: "Chordata", class: "Mammalia", order: "Carnivora",
      family: "Felidae", genus: "Panthera", species: "Panthera leo", cached: false,
    }],
    external_available: true,
    warning: null,
  });
  api.selectAnimalTaxon.mockResolvedValue({});
  api.deletePhoto.mockResolvedValue({ status: "trashed", photo_id: 44 });
});

test("curates a photo directly with accessible Favorite and rating controls", async () => {
  let current = photo({ status: "needs_review", reviewed_at: null });
  api.getPhoto.mockResolvedValue(current);
  api.updatePhoto.mockImplementation(async (_id, values) => {
    current = { ...current, ...values, updated_at: "2026-08-12T10:00:00Z" };
    return current;
  });
  render(<PhotoDetail id="44" />);
  const favorite = await screen.findByRole("button", { name: "Favorite", pressed: false });
  await userEvent.click(favorite);
  await screen.findByRole("button", { name: "Favorite", pressed: true });
  expect(api.updatePhoto).toHaveBeenLastCalledWith(44, { is_favorite: true }, "2026-08-12T08:00:00Z");
  await userEvent.click(screen.getByRole("radio", { name: "Rate 5 stars" }));
  await screen.findByText("5 out of 5 stars");
  await userEvent.click(screen.getByRole("radio", { name: "Rate 2 stars" }));
  await screen.findByText("2 out of 5 stars");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Rate 2 stars" }).checked).toBe(true);
  screen.getByRole("radio", { name: "Rate 3 stars" }).focus();
  await userEvent.keyboard(" ");
  await screen.findByText("3 out of 5 stars");
  await userEvent.click(screen.getByRole("button", { name: "Clear rating" }));
  await screen.findByText("Unrated");
  expect(api.updatePhoto).toHaveBeenLastCalledWith(44, { rating: null }, current.updated_at);
  await userEvent.click(screen.getByRole("button", { name: "Favorite", pressed: true }));
  await screen.findByRole("button", { name: "Favorite", pressed: false });
  expect(current.status).toBe("needs_review");
  expect(current.reviewed_at).toBeNull();
  expect(screen.queryByRole("button", { name: "Editing metadata" })).toBeNull();
});

test("curation failures and pending saves retain confirmed values and block overlapping edits", async () => {
  api.updatePhoto.mockRejectedValue(new Error("Photo changed. Refresh before saving."));
  render(<PhotoDetail id="44" />);
  const favorite = await screen.findByRole("button", { name: "Favorite" });
  await userEvent.click(favorite);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Refresh before saving"));
  expect(favorite.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("Unrated")).toBeTruthy();
  let finish!: (value: Photo) => void;
  api.updatePhoto.mockReturnValue(new Promise<Photo>((resolve) => { finish = resolve; }));
  await userEvent.click(screen.getByRole("radio", { name: "Rate 5 stars" }));
  expect(screen.getByText("Saving…")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Edit metadata" }).disabled).toBe(true);
  expect(favorite.getAttribute("aria-pressed")).toBe("false");
  finish(photo({ rating: 5 }));
  await screen.findByText("5 out of 5 stars");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Edit metadata" }).disabled).toBe(false);
});

test("capture parsers preserve camera-local time and reject invalid groups", () => {
  expect(formatCameraLocalDate("0024-05-24T18:42:00")).toBe("May 24, 24");
  expect(parseCaptureFields("2026-01-02T23:59:59.123456", "-05:30")).toEqual({ captured_at: "2026-01-02T23:59:59.123456", captured_at_offset_minutes: -330 });
  expect(parseCaptureFields("2026-01-02T23:59", "")).toEqual({ captured_at: "2026-01-02T23:59:00", captured_at_offset_minutes: null });
  expect(parseCaptureFields("", "")).toEqual({ captured_at: null, captured_at_offset_minutes: null });
  expect(() => parseCaptureFields("2026-02-30T10:00", "")).toThrow();
  expect(() => parseCaptureFields("2026-01-02T10:00Z", "")).toThrow();
  expect(() => parseCaptureFields("2026-01-02T10:00", "+24:00")).toThrow();
  expect(() => parseCaptureFields("", "+01:00")).toThrow();
  expect(parseLocationFields("46.123456789", "14.987654321")).toEqual({ latitude: 46.123456789, longitude: 14.987654321 });
  expect(parseLocationFields("0", "0")).toEqual({ latitude: 0, longitude: 0 });
  for (const coordinates of [["1", ""], ["91", "0"], ["0", "-181"], ["NaN", "1"], ["Infinity", "0"]]) {
    expect(() => parseLocationFields(...coordinates as [string, string])).toThrow();
  }
});

test("adds capture/GPS values with the editing version and refreshes the detail map", async () => {
  api.updatePhoto.mockImplementation(async (_id, update) => photo({ ...update, capture_metadata_overridden: true, location_metadata_overridden: true }));
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  fireEvent.change(screen.getByLabelText("Capture date/time"), { target: { value: "2026-01-02T23:59:59.123" } });
  await userEvent.type(screen.getByLabelText("UTC offset"), "+02:30");
  await userEvent.type(screen.getByLabelText("Latitude"), "46.123456789");
  await userEvent.type(screen.getByLabelText("Longitude"), "14.987654321");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updatePhoto).toHaveBeenCalledWith(44, expect.objectContaining({ captured_at: "2026-01-02T23:59:59.123", captured_at_offset_minutes: 150, latitude: 46.123456789, longitude: 14.987654321 }), "2026-08-12T08:00:00Z"));
  expect(screen.getByRole("region", { name: "Test map for Lion" }).getAttribute("data-latitude")).toBe("46.123456789");
  expect(screen.getAllByText(/Manually edited/)).toHaveLength(2);
});

test("clears date/offset and location and removes the detail map", async () => {
  api.getPhoto.mockResolvedValue(photo({ captured_at: "2024-05-24T18:42:00", captured_at_offset_minutes: 120, latitude: 46, longitude: 14 }));
  api.updatePhoto.mockImplementation(async (_id, update) => photo({ ...update, capture_metadata_overridden: true, location_metadata_overridden: true }));
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  await userEvent.click(screen.getByRole("button", { name: "Clear capture date" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove location" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updatePhoto).toHaveBeenCalledWith(44, expect.objectContaining({ captured_at: null, captured_at_offset_minutes: null, latitude: null, longitude: null }), expect.any(String)));
  expect(screen.queryByRole("region", { name: "Test map for Lion" })).toBeNull();
  expect(screen.getAllByText(/Manually cleared/)).toHaveLength(2);
});

test("partial GPS keeps the draft without sending a request", async () => {
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  await userEvent.type(screen.getByLabelText("Latitude"), "46");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Enter both latitude and longitude/)).toBeTruthy();
  expect(api.updatePhoto).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("46");
});

test("restore is staged, cancellable, and sent without conflicting capture values", async () => {
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  await userEvent.click(screen.getByRole("button", { name: "Restore original metadata" }));
  expect(screen.getByText(/Save will re-read/)).toBeTruthy();
  expect(api.updatePhoto).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel restore" }));
  expect(screen.queryByText(/Save will re-read/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Restore original metadata" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updatePhoto).toHaveBeenCalled());
  const update = api.updatePhoto.mock.calls[0][1];
  expect(update.restore_original_metadata).toBe(true);
  expect(update).not.toHaveProperty("captured_at");
  expect(update).not.toHaveProperty("latitude");
});

test("cancel discards capture edits and a stale save keeps the draft", async () => {
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  await userEvent.type(screen.getByLabelText("Latitude"), "46");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(api.updatePhoto).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("");
  await userEvent.type(screen.getByLabelText("Latitude"), "46");
  await userEvent.type(screen.getByLabelText("Longitude"), "14");
  api.updatePhoto.mockRejectedValueOnce(new Error("Photo changed. Refresh before saving."));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/Refresh before saving/)).toBeTruthy();
  expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("46");
});

test("an unrelated edit preserves full capture precision and does not mark groups manual", async () => {
  api.getPhoto.mockResolvedValue(photo({ captured_at: "2024-05-24T18:42:00.123456", captured_at_offset_minutes: -330, latitude: 46.123456789, longitude: 14.987654321 }));
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));
  expect((screen.getByLabelText("UTC offset") as HTMLInputElement).value).toBe("-05:30");
  expect((screen.getByLabelText("Latitude") as HTMLInputElement).value).toBe("46.123456789");
  await userEvent.type(screen.getByLabelText("Display title"), " edited");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.updatePhoto).toHaveBeenCalled());
  expect(api.updatePhoto.mock.calls[0][1]).not.toHaveProperty("captured_at");
  expect(api.updatePhoto.mock.calls[0][1]).not.toHaveProperty("latitude");
});

test("shows extracted capture metadata separately from the archive date", async () => {
  api.getPhoto.mockResolvedValue(
    photo({
      captured_at: "2024-05-24T18:42:00",
      captured_at_offset_minutes: 120,
      camera_make: "SONY",
      camera_model: "SONY ILCE-7M4",
      lens_model: "FE 200-600mm",
      image_width: 7008,
      image_height: 4672,
      latitude: 46.12345,
      longitude: 14.54321,
    }),
  );

  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });

  expect(screen.getByText("May 24, 2024, 6:42 PM · UTC+02:00")).toBeTruthy();
  expect(screen.getByText("SONY ILCE-7M4")).toBeTruthy();
  expect(screen.getByText("FE 200-600mm")).toBeTruthy();
  expect(screen.getByText("7008 × 4672")).toBeTruthy();
  expect(screen.getByText("46.12345, 14.54321")).toBeTruthy();
  expect(screen.getByText("Added to FaunaVault")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Test map for Lion" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "View on map" }).getAttribute("href"))
    .toBe("/map?photo=44");
});

test("omits absent extracted rows and labels unknown capture timezone", async () => {
  api.getPhoto.mockResolvedValue(
    photo({ captured_at: "2024-05-24T18:42:00" }),
  );

  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });

  expect(screen.getByText(/timezone not recorded/)).toBeTruthy();
  expect(screen.queryByText("Camera")).toBeNull();
  expect(screen.queryByText("Lens")).toBeNull();
  expect(screen.getByText("Location")).toBeTruthy();
  expect(screen.getByText("Not recorded")).toBeTruthy();
  expect(screen.queryByText("Location map")).toBeNull();
  expect(screen.queryByRole("link", { name: "View on map" })).toBeNull();
});

test("loads the detail and preserves the exact metadata update payload", async () => {
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });
  await userEvent.click(screen.getByRole("button", { name: "Edit metadata" }));

  const displayTitle = screen.getByRole("textbox", { name: "Display title" });
  await userEvent.clear(displayTitle);
  const confidence = screen.getByRole("spinbutton", { name: "Confidence" });
  await userEvent.clear(confidence);
  await userEvent.type(confidence, "25");
  const tags = screen.getByRole("textbox", { name: "Tags" });
  await userEvent.clear(tags);
  await userEvent.type(tags, " cat, savanna, cat ");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() =>
    expect(api.updatePhoto).toHaveBeenCalledWith(44, {
      display_title: null,
      common_name: "lion",
      breed_guess: null,
      species_guess: "Panthera leo",
      category: "mammal",
      confidence: 0.25,
      description: "Adult lion",
      tags: ["cat", "savanna"],
      status: "classified",
    }, "2026-08-12T08:00:00Z"),
  );
  expect(screen.getByRole("button", { name: "Edit metadata" })).toBeTruthy();
});

test("keeps taxonomy interaction local to the linked animal section", async () => {
  render(<PhotoDetail id="44" />);
  const input = await screen.findByPlaceholderText("Common or scientific name");
  await userEvent.type(input, "Panthera leo");
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await userEvent.click(await screen.findByRole("button", { name: /Lion/ }));

  expect(api.searchTaxonomy).toHaveBeenCalledWith("Panthera leo");
  expect(api.selectAnimalTaxon).toHaveBeenCalledWith(12, 5219404);
  expect(api.getPhoto).toHaveBeenCalledTimes(1);
});

test("keeps AI enqueue and mock updates inside the classification boundary", async () => {
  api.classifyPhoto.mockResolvedValue({
    jobs: [{
      created: true,
      job: {
        id: 91, photo_id: 44, status: "queued", batch_id: "detail-44",
        batch_kind: "reclassification", requested_model: "llava", fallback_model: null,
        actual_model: null, fallback_attempted: false, prompt_version: "v1",
        attempt_count: 0, created_at: "2026-08-12T08:00:00Z",
        queued_at: "2026-08-12T08:00:00Z", started_at: null, finished_at: null,
        duration_ms: null, failure_code: null, failure_message: null,
        classification_status: null, photo_original_filename: "lion.jpg", retryable: false,
      },
    }],
    rejected: [],
    summary: { total: 1, queued: 1, running: 0, succeeded: 0, failed: 0 },
  });
  api.mockClassifyPhoto.mockResolvedValue(
    photo({ display_title: "Mock classified lion", confidence: 0.75 }),
  );
  render(<PhotoDetail id="44" />);
  await screen.findByRole("heading", { name: "Lion" });

  await userEvent.click(screen.getByRole("button", { name: "Reclassify with local AI" }));
  await waitFor(() => expect(api.classifyPhoto).toHaveBeenCalledWith(44));

  await userEvent.click(screen.getByRole("button", { name: "Run mock classification" }));
  expect(await screen.findByRole("heading", { name: "Mock classified lion" })).toBeTruthy();
  expect(api.mockClassifyPhoto).toHaveBeenCalledWith(44);
  expect(api.getPhoto).toHaveBeenCalledTimes(1);
});

test("opens the existing lightbox from the extracted media boundary", async () => {
  render(<PhotoDetail id="44" />);
  const trigger = await screen.findByRole("button", { name: "Open fullscreen image" });
  await userEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Fullscreen image viewer" });
  expect(dialog).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("keeps long detail content inside width-constrained media and metadata", async () => {
  const filename = `${"very-long-field-record-".repeat(10)}.jpg`;
  const species = `Panthera ${"scientific-name-".repeat(10)}`;
  api.getPhoto.mockResolvedValue(
    photo({
      original_filename: filename,
      display_title: `Lion ${"observation-".repeat(8)}`,
      species_guess: species,
      description: `Detail ${"unbroken".repeat(20)}`,
    }),
  );

  render(<PhotoDetail id="44" />);

  const mediaTrigger = await screen.findByRole("button", {
    name: "Open fullscreen image",
  });
  expect(mediaTrigger.closest("section")?.className).toContain("min-w-0");
  expect(screen.getByRole("complementary").className).toContain("min-w-0");
  expect(screen.getByText(filename)).toBeTruthy();
  expect(screen.getAllByText(species)).toHaveLength(2);
});

test("moves to Trash and navigates to the sanitized return location", async () => {
  render(<PhotoDetail id="44" returnTo="/?catalog_page=2" />);
  const trigger = await screen.findByRole("button", { name: "Move to Trash" });
  await userEvent.click(trigger);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Type the filename to confirm" }),
    "lion.jpg",
  );
  await userEvent.click(screen.getAllByRole("button", { name: "Move to Trash" })[1]);

  await waitFor(() => expect(window.location.search).toBe("?catalog_page=2"));
  expect(api.deletePhoto).toHaveBeenCalledWith(44);
  expect(window.sessionStorage.getItem("faunavault.success")).toBe(
    "Moved lion.jpg to Trash.",
  );
});

test("shows load failures and rejects unsafe return locations", async () => {
  api.getPhoto.mockRejectedValue(new Error("Photo service unavailable"));
  render(<PhotoDetail id="44" returnTo="//example.com/escape" />);

  expect(await screen.findByText("Photo service unavailable")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Photo not found" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to catalog" }).getAttribute("href")).toBe("/");
});
