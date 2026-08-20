import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import AlbumDetailView from "../app/albums/[albumKey]/album-detail";
import AnimalNameEditor from "../app/components/animal-name-editor";
import { Animal, Photo } from "../app/lib/api";
import PhotoDetail from "../app/photos/[id]/photo-detail";

const api = vi.hoisted(() => ({
  deletePhoto: vi.fn(),
  getAnimal: vi.fn(),
  getPhoto: vi.fn(),
  getSpeciesAlbum: vi.fn(),
  searchTaxonomy: vi.fn(),
  selectAlbumTaxon: vi.fn(),
  updateAnimalDisplayName: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return {
    ...original,
    deletePhoto: api.deletePhoto,
    getAnimal: api.getAnimal,
    getPhoto: api.getPhoto,
    getSpeciesAlbum: api.getSpeciesAlbum,
    searchTaxonomy: api.searchTaxonomy,
    selectAlbumTaxon: api.selectAlbumTaxon,
    updateAnimalDisplayName: api.updateAnimalDisplayName,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function makeAnimal(overrides: Partial<Animal> = {}): Animal {
  return {
    id: 12,
    identifier: "FV-P000012",
    display_name: null,
    taxon_id: null,
    legacy_common_name: "lion",
    legacy_species_name: "Panthera leo",
    taxonomy_status: "unreviewed",
    taxonomy_note: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function StatefulEditor({ initialAnimal }: { initialAnimal: Animal }) {
  const [animal, setAnimal] = useState(initialAnimal);
  return <AnimalNameEditor animal={animal} onUpdated={setAnimal} />;
}

function makePhoto(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 44,
    original_filename: "lion.jpg",
    stored_filename: "lion.jpg",
    resized_filename: "lion-resized.jpg",
    thumbnail_filename: "lion-thumb.jpg",
    display_title: "Lion portrait",
    common_name: "lion",
    breed_guess: null,
    species_guess: "Panthera leo",
    category: "mammal",
    confidence: 0.9,
    description: null,
    tags: [],
    status: "classified",
    animal_id: 12,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    deleted_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.deletePhoto.mockResolvedValue({ status: "trashed", photo_id: 44 });
});

test("presents a named animal with its stable identifier as secondary metadata", () => {
  render(
    <AnimalNameEditor
      animal={makeAnimal({ display_name: "Bella" })}
      onUpdated={vi.fn()}
    />,
  );

  expect(screen.getByText("Bella")).toBeTruthy();
  expect(screen.getByText("FV-P000012")).toBeTruthy();
});

test("presents an unnamed animal with the stable identifier and fallback wording", () => {
  render(<AnimalNameEditor animal={makeAnimal()} onUpdated={vi.fn()} />);

  expect(screen.getByText("FV-P000012")).toBeTruthy();
  expect(screen.getByText("Unnamed individual")).toBeTruthy();
});

test("opens the rename editor with the current name and cancels without saving", async () => {
  render(<StatefulEditor initialAnimal={makeAnimal({ display_name: "Bella" })} />);

  await userEvent.click(
    screen.getByRole("button", { name: "Edit name for FV-P000012" }),
  );
  const input = screen.getByRole("textbox", { name: "Animal display name" });
  expect((input as HTMLInputElement).value).toBe("Bella");
  await userEvent.clear(input);
  await userEvent.type(input, "New name");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.getByText("Bella")).toBeTruthy();
  expect(api.updateAnimalDisplayName).not.toHaveBeenCalled();
});

test("saves a display name and updates the presentation", async () => {
  api.updateAnimalDisplayName.mockResolvedValue(
    makeAnimal({ display_name: "Camel 1" }),
  );
  render(<StatefulEditor initialAnimal={makeAnimal()} />);

  await userEvent.click(
    screen.getByRole("button", { name: "Edit name for FV-P000012" }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Animal display name" }),
    "Camel 1",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Camel 1")).toBeTruthy();
  expect(api.updateAnimalDisplayName).toHaveBeenCalledWith(12, "Camel 1");
  expect(screen.getByText("FV-P000012")).toBeTruthy();
});

test("removes an existing name and restores the unnamed fallback", async () => {
  api.updateAnimalDisplayName.mockResolvedValue(
    makeAnimal({ display_name: null }),
  );
  render(<StatefulEditor initialAnimal={makeAnimal({ display_name: "Bella" })} />);

  await userEvent.click(
    screen.getByRole("button", { name: "Edit name for FV-P000012" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Remove name" }));

  expect(await screen.findByText("Unnamed individual")).toBeTruthy();
  expect(api.updateAnimalDisplayName).toHaveBeenCalledWith(12, null);
  expect(screen.getByText("FV-P000012")).toBeTruthy();
});

test("shows validation and API failure states in the rename editor", async () => {
  const { unmount } = render(<StatefulEditor initialAnimal={makeAnimal()} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Edit name for FV-P000012" }),
  );
  const input = screen.getByRole("textbox", { name: "Animal display name" });
  fireEvent.change(input, { target: { value: "x".repeat(101) } });

  expect(
    screen.getByText("Name must be 100 characters or fewer."),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.updateAnimalDisplayName).not.toHaveBeenCalled();

  unmount();
  api.updateAnimalDisplayName.mockRejectedValueOnce(new Error("Backend offline"));
  render(<StatefulEditor initialAnimal={makeAnimal()} />);
  await userEvent.click(
    screen.getByRole("button", { name: "Edit name for FV-P000012" }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Animal display name" }),
    "Bella",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(
    await screen.findByText("Could not update name: Backend offline"),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Animal display name",
      }) as HTMLInputElement
    ).value,
  ).toBe("Bella");
});

test("updates the animal name in the album without reloading album state", async () => {
  api.getSpeciesAlbum.mockResolvedValue({
    album_key: "legacy:UGFudGhlcmEgbGVv",
    verified: false,
    common_name: "Lion",
    scientific_name: "Panthera leo",
    rank: null,
    class: "Mammalia",
    order: "Carnivora",
    family: "Felidae",
    genus: "Panthera",
    species: "Panthera leo",
    animal_count: 1,
    photo_count: 0,
    newest_at: "2026-01-01T00:00:00Z",
    cover_photo_id: null,
    cover_thumbnail_filename: null,
    taxonomy: null,
    animals: {
      items: [makeAnimal()],
      total: 1,
      page: 1,
      page_size: 50,
    },
    photos: { items: [], total: 0, page: 1, page_size: 24 },
  });
  api.updateAnimalDisplayName.mockResolvedValue(
    makeAnimal({ display_name: "Bella" }),
  );
  render(<AlbumDetailView albumKey="legacy:UGFudGhlcmEgbGVv" />);

  await userEvent.click(
    await screen.findByRole("button", {
      name: "Edit name for FV-P000012",
    }),
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Animal display name" }),
    "Bella",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText("Bella")).toBeTruthy();
  expect(screen.getByText("FV-P000012")).toBeTruthy();
  await waitFor(() =>
    expect(api.updateAnimalDisplayName).toHaveBeenCalledWith(12, "Bella"),
  );
  expect(api.getSpeciesAlbum).toHaveBeenCalledTimes(1);
});

test("uses the verified album key for loads after taxonomy linking", async () => {
  api.getSpeciesAlbum.mockResolvedValue({
    album_key: "legacy:UGFudGhlcmEgbGVv",
    verified: false,
    common_name: null,
    scientific_name: "Panthera leo",
    rank: null,
    class: null,
    order: null,
    family: null,
    genus: null,
    species: "Panthera leo",
    animal_count: 51,
    photo_count: 0,
    newest_at: "2026-01-01T00:00:00Z",
    cover_photo_id: null,
    cover_thumbnail_filename: null,
    taxonomy: null,
    animals: { items: [makeAnimal()], total: 51, page: 1, page_size: 50 },
    photos: { items: [], total: 0, page: 1, page_size: 24 },
  });
  const candidate = {
    provider: "gbif" as const,
    external_taxon_id: 5219404,
    scientific_name: "Panthera leo",
    canonical_name: "Panthera leo",
    common_name: "Lion",
    rank: "SPECIES",
    kingdom: "Animalia",
    phylum: "Chordata",
    class: "Mammalia",
    order: "Carnivora",
    family: "Felidae",
    genus: "Panthera",
    species: "Panthera leo",
    cached: false,
  };
  api.searchTaxonomy.mockResolvedValue({
    results: [candidate],
    external_available: true,
    warning: null,
  });
  api.selectAlbumTaxon.mockResolvedValue({
    album_key: "taxon:7",
    updated_animals: 51,
    taxon: candidate,
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<AlbumDetailView albumKey="legacy:UGFudGhlcmEgbGVv" />);

  await userEvent.type(
    await screen.findByPlaceholderText("e.g. Panthera leo"),
    "Panthera leo",
  );
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  const candidateButton = await screen.findByRole("button", { name: /Lion/ });
  expect(candidateButton.className).toContain("min-w-0");
  await userEvent.click(candidateButton);
  await waitFor(() =>
    expect(api.getSpeciesAlbum).toHaveBeenCalledWith(
      "taxon:7",
      expect.any(URLSearchParams),
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => {
    const lastCall = api.getSpeciesAlbum.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("taxon:7");
  });
});

test("shows and edits the linked animal from photo detail", async () => {
  api.getPhoto.mockResolvedValue(makePhoto());
  api.getAnimal.mockResolvedValue(makeAnimal({ display_name: "Bella" }));
  render(<PhotoDetail id="44" />);

  expect(await screen.findByText("Linked individual")).toBeTruthy();
  expect(await screen.findByText("Bella")).toBeTruthy();
  expect(screen.getByText("FV-P000012")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Edit name for FV-P000012" }),
  );

  expect(
    (
      screen.getByRole("textbox", {
        name: "Animal display name",
      }) as HTMLInputElement
    ).value,
  ).toBe("Bella");
  expect(api.getAnimal).toHaveBeenCalledWith(12);
});

test("keeps the photo-detail delete confirmation focus-safe through errors", async () => {
  let rejectDelete: (error: Error) => void = () => undefined;
  const addEventListenerSpy = vi.spyOn(window, "addEventListener");
  api.getPhoto.mockResolvedValue(makePhoto());
  api.getAnimal.mockResolvedValue(makeAnimal());
  api.deletePhoto.mockImplementation(
    () => new Promise((_, reject) => { rejectDelete = reject; }),
  );
  const user = userEvent.setup();
  render(<PhotoDetail id="44" />);

  expect(
    addEventListenerSpy.mock.calls.filter(([eventName]) => eventName === "keydown"),
  ).toHaveLength(0);

  const trigger = await screen.findByRole("button", { name: "Move to Trash" });
  await user.click(trigger);
  let dialog = screen.getByRole("dialog", { name: "Move photo to Trash" });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  const input = screen.getByRole("textbox", { name: "Type the filename to confirm" });
  const submit = screen.getAllByRole("button", { name: "Move to Trash" })[1];

  expect(dialog.getAttribute("aria-describedby")).toBe("delete-photo-description");
  expect(document.activeElement).toBe(cancel);
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  await user.tab();
  expect(document.activeElement).toBe(input);

  await user.type(input, "partial confirmation");
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));

  await user.click(trigger);
  dialog = screen.getByRole("dialog");
  expect(
    screen.getByRole<HTMLInputElement>("textbox", {
      name: "Type the filename to confirm",
    }).value,
  ).toBe("");
  await user.type(
    screen.getByRole("textbox", { name: "Type the filename to confirm" }),
    "lion.jpg",
  );
  const pendingSubmit = screen.getAllByRole("button", { name: "Move to Trash" })[1];
  await user.click(pendingSubmit);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBe(dialog);

  rejectDelete(new Error("Delete service unavailable"));
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "Delete service unavailable",
  );
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Cancel" }).disabled).toBe(false);
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Type the filename to confirm" }),
  );
  expect(screen.getByRole("dialog")).toBe(dialog);
  addEventListenerSpy.mockRestore();
});
