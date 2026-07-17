import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Home from "../app/page";
import ImageLightbox from "../app/components/image-lightbox";

const api = vi.hoisted(() => ({
  getPhotos: vi.fn(),
  getSpeciesAlbums: vi.fn(),
  getTaxonomyFilters: vi.fn(),
  reconcileTaxonomy: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return {
    ...original,
    getPhotos: api.getPhotos,
    getSpeciesAlbums: api.getSpeciesAlbums,
    getTaxonomyFilters: api.getTaxonomyFilters,
    reconcileTaxonomy: api.reconcileTaxonomy,
  };
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  api.getPhotos.mockResolvedValue([]);
  api.getTaxonomyFilters.mockResolvedValue({
    classes: [], orders: [], families: [], genera: [], species: [],
  });
  api.getSpeciesAlbums.mockResolvedValue({
    items: [{
      album_key: "legacy:bGlvbg",
      verified: false,
      common_name: null,
      scientific_name: "Panthera leo",
      rank: null,
      class: null,
      order: null,
      family: null,
      genus: null,
      species: "Panthera leo",
      animal_count: 2,
      photo_count: 3,
      newest_at: "2026-01-01T00:00:00Z",
      cover_photo_id: null,
      cover_thumbnail_filename: null,
    }],
    total: 1,
    page: 1,
    page_size: 24,
  });
});

test("switches between List and Album and renders an unverified card", async () => {
  render(<Home />);
  expect(await screen.findByText("Start your animal archive")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "album" }));
  expect(await screen.findByText("Panthera leo")).toBeTruthy();
  expect(screen.getByText("Unverified")).toBeTruthy();
  expect(screen.getByText("No photograph available")).toBeTruthy();
  expect(window.location.search).toContain("view=album");
  await userEvent.click(screen.getByRole("button", { name: "list" }));
  expect(screen.getByText("Start your animal archive")).toBeTruthy();
});

test("album search updates results and URL state", async () => {
  render(<Home />);
  await userEvent.click(await screen.findByRole("button", { name: "album" }));
  const search = screen.getByPlaceholderText("Common or scientific name");
  await userEvent.type(search, "lion");
  await waitFor(() => expect(api.getSpeciesAlbums).toHaveBeenCalled());
  expect(window.location.search).toContain("q=lion");
});

describe("image lightbox", () => {
  test("supports next, previous, Escape, and broken images", async () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        images={[
          { imageUrl: "/one.jpg", alt: "One", caption: "Animal one" },
          { imageUrl: "/two.jpg", alt: "Two", caption: "Animal two" },
        ]}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Loading image…")).toBeTruthy();
    fireEvent.error(screen.getByAltText("One"));
    expect(screen.getByText("Image unavailable")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByAltText("Two")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Animal one")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
