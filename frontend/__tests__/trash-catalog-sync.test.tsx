import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import { Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  deletePhoto: vi.fn(),
  getCatalogPhotos: vi.fn(),
  getTrashPhotos: vi.fn(),
  restoreTrashPhoto: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return { ...original, ...api };
});

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 7,
    original_filename: "fox.jpg",
    stored_filename: "fox.jpg",
    resized_filename: "fox-resized.jpg",
    thumbnail_filename: "fox-thumb.jpg",
    display_title: "Red fox",
    common_name: "fox",
    breed_guess: null,
    species_guess: "Vulpes vulpes",
    category: "mammal",
    confidence: 0.93,
    description: null,
    tags: [],
    status: "classified",
    animal_id: 4,
    content_sha256: "a".repeat(64),
    original_size_bytes: 100,
    media_type: "image/jpeg",
    deleted_at: null,
    created_at: "2026-08-10T08:00:00Z",
    updated_at: "2026-08-11T08:00:00Z",
    ...overrides,
  };
}

let activePhotos: Photo[];
let trashPhotos: Photo[];

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  window.sessionStorage.clear();
  activePhotos = [photo()];
  trashPhotos = [];

  api.getCatalogPhotos.mockImplementation(async (query) => {
    const items = activePhotos.filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.category || item.category === query.category) &&
        (!query.uncategorized || !item.category?.trim()) &&
        (!query.search ||
          [item.display_title, item.common_name, item.species_guess, item.category]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(query.search.toLowerCase())),
    );
    const categories = Array.from(
      new Set(activePhotos.map((item) => item.category).filter(Boolean)),
    ).map((value) => ({
      value: value as string,
      count: activePhotos.filter((item) => item.category === value).length,
    }));
    return {
      items,
      total: items.length,
      page: query.page,
      page_size: query.page_size,
      total_pages: items.length ? 1 : 0,
      facets: {
        active_total: activePhotos.length,
        status_counts: {
          pending: activePhotos.filter((item) => item.status === "pending").length,
          classified: activePhotos.filter((item) => item.status === "classified").length,
          needs_review: activePhotos.filter((item) => item.status === "needs_review").length,
        },
        categories,
        uncategorized_count: activePhotos.filter((item) => !item.category?.trim()).length,
      },
    };
  });
  api.getTrashPhotos.mockImplementation(async () => ({
    items: [...trashPhotos],
    total: trashPhotos.length,
    page: 1,
    page_size: 24,
  }));
  api.deletePhoto.mockImplementation(async (id: number) => {
    const movedPhoto = activePhotos.find((item) => item.id === id);
    if (movedPhoto) {
      activePhotos = activePhotos.filter((item) => item.id !== id);
      trashPhotos = [
        ...trashPhotos,
        { ...movedPhoto, deleted_at: "2026-08-11T09:00:00Z" },
      ];
    }
    return { status: "trashed", photo_id: id };
  });
  api.restoreTrashPhoto.mockImplementation(async (id: number) => {
    const restoredPhoto = trashPhotos.find((item) => item.id === id);
    if (restoredPhoto) {
      trashPhotos = trashPhotos.filter((item) => item.id !== id);
      activePhotos = [
        ...activePhotos.filter((item) => item.id !== id),
        { ...restoredPhoto, deleted_at: null },
      ];
    }
    return { status: "restored", photo_id: id };
  });
});

async function moveToTrash(title: string) {
  const card = (await screen.findByRole("heading", { name: title })).closest(
    "article",
  );
  if (!card) throw new Error(`Could not find the ${title} catalog card`);

  await userEvent.click(
    within(card).getByRole("button", { name: "Move to Trash" }),
  );
  await userEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Move to Trash",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: title })).toBeNull(),
  );
}

async function openCollectionView(name: "List" | "Trash") {
  await userEvent.click(
    screen.getByRole("button", { name: new RegExp(`^${name}$`, "i") }),
  );
}

async function restoreFromTrash(title: string) {
  const card = (await screen.findByRole("heading", { name: title })).closest(
    "article",
  );
  if (!card) throw new Error(`Could not find the ${title} Trash card`);
  await userEvent.click(within(card).getByRole("button", { name: "Restore" }));
}

function expectCatalogCount(visible: number, total: number) {
  expect(
    screen.getByText(
      (_, element) =>
        element?.textContent?.replace(/\s+/g, " ").trim() ===
        `Showing ${visible} of ${total} ${total === 1 ? "record" : "records"}`,
    ),
  ).toBeTruthy();
}

test("restored photo returns to List without remounting or refreshing", async () => {
  render(<Home />);

  await moveToTrash("Red fox");
  await openCollectionView("Trash");
  await restoreFromTrash("Red fox");

  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: "Red fox" })).toBeNull(),
  );
  expect(screen.getByText("Trash is empty.")).toBeTruthy();
  expect(
    screen.getByText("Restored fox.jpg to the catalog."),
  ).toBeTruthy();

  await openCollectionView("List");
  expect(
    await screen.findByRole("heading", { name: "Red fox" }),
  ).toBeTruthy();
});

test("restoring multiple photos keeps one catalog entry for each photo", async () => {
  activePhotos = [
    photo(),
    photo({
      id: 8,
      original_filename: "sparrow.jpg",
      stored_filename: "sparrow.jpg",
      resized_filename: "sparrow-resized.jpg",
      thumbnail_filename: "sparrow-thumb.jpg",
      display_title: "House sparrow",
      common_name: "sparrow",
      species_guess: "Passer domesticus",
      category: "bird",
      animal_id: 5,
      content_sha256: "b".repeat(64),
    }),
  ];
  render(<Home />);

  await moveToTrash("Red fox");
  await moveToTrash("House sparrow");
  await openCollectionView("Trash");
  await restoreFromTrash("Red fox");
  await restoreFromTrash("House sparrow");
  await openCollectionView("List");

  expect(await screen.findAllByRole("heading", { name: "Red fox" })).toHaveLength(1);
  expect(
    screen.getAllByRole("heading", { name: "House sparrow" }),
  ).toHaveLength(1);
  expectCatalogCount(2, 2);
});

test("an active filter may keep a nonmatching restored photo hidden", async () => {
  activePhotos = [
    photo(),
    photo({
      id: 8,
      original_filename: "sparrow.jpg",
      stored_filename: "sparrow.jpg",
      resized_filename: "sparrow-resized.jpg",
      thumbnail_filename: "sparrow-thumb.jpg",
      display_title: "House sparrow",
      common_name: "sparrow",
      species_guess: "Passer domesticus",
      category: "bird",
      animal_id: 5,
      content_sha256: "b".repeat(64),
    }),
  ];
  render(<Home />);

  await moveToTrash("Red fox");
  await userEvent.selectOptions(screen.getByLabelText("Category"), "bird");
  await openCollectionView("Trash");
  await restoreFromTrash("Red fox");
  await openCollectionView("List");

  expect(screen.queryByRole("heading", { name: "Red fox" })).toBeNull();
  expect(
    await screen.findByRole("heading", { name: "House sparrow" }),
  ).toBeTruthy();
  expectCatalogCount(1, 1);

  await userEvent.selectOptions(screen.getByLabelText("Category"), "all");
  expect(
    await screen.findByRole("heading", { name: "Red fox" }),
  ).toBeTruthy();
});
