import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import PhotoDetail from "../app/photos/[id]/photo-detail";
import { Animal, Photo } from "../app/lib/api";

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

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 44,
    original_filename: "lion.jpg",
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
    deleted_at: null,
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
      tags: ["cat", "savanna", "cat"],
      status: "classified",
    }),
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
