import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import Home from "../app/page";
import ImageLightbox from "../app/components/image-lightbox";

const api = vi.hoisted(() => ({
  getCatalogPhotos: vi.fn(),
  getSpeciesAlbums: vi.fn(),
  getTaxonomyFilters: vi.fn(),
  reconcileTaxonomy: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return {
    ...original,
    getCatalogPhotos: api.getCatalogPhotos,
    getSpeciesAlbums: api.getSpeciesAlbums,
    getTaxonomyFilters: api.getTaxonomyFilters,
    reconcileTaxonomy: api.reconcileTaxonomy,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  api.getCatalogPhotos.mockImplementation(async (query) => ({
    items: [],
    total: 0,
    page: query.page,
    page_size: query.page_size,
    total_pages: 0,
    facets: {
      active_total: 0,
      status_counts: { pending: 0, classified: 0, needs_review: 0 },
      categories: [],
      uncategorized_count: 0,
    },
  }));
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
  api.reconcileTaxonomy.mockResolvedValue({
    processed: 2,
    linked: 2,
    ambiguous: 0,
    unmatched: 0,
    failed: 0,
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

test("taxonomy reconciliation resets a stale album page before refreshing", async () => {
  window.history.replaceState(null, "", "/?view=album&page=3");
  api.getSpeciesAlbums.mockImplementation(async (params: URLSearchParams) => ({
    items: [],
    total: 72,
    page: Number(params.get("page")),
    page_size: 24,
  }));
  render(<Home />);

  await waitFor(() =>
    expect(
      api.getSpeciesAlbums.mock.calls.some(
        ([params]) => params.get("page") === "3",
      ),
    ).toBe(true),
  );
  await userEvent.click(screen.getByRole("button", { name: "Match unverified names" }));
  await waitFor(() =>
    expect(
      api.getSpeciesAlbums.mock.calls.some(
        ([params]) => params.get("page") === "1",
      ),
    ).toBe(true),
  );
  expect(window.location.search).not.toContain("page=3");
});

describe("image lightbox", () => {
  test("supports next, previous, Escape, and broken images", async () => {
    const onClose = vi.fn();
    render(
      <ImageLightbox
        images={[
          {
            imageUrl: "/one.jpg",
            alt: "One",
            caption: `Animal one ${"long-caption-".repeat(12)}`,
          },
          { imageUrl: "/two.jpg", alt: "Two", caption: "Animal two" },
        ]}
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Fullscreen image viewer" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByText("Loading image…")).toBeTruthy();
    const caption = screen.getByText(/Animal one long-caption/);
    expect(caption.className).toContain("break-words");
    expect(caption.className).not.toContain("truncate");
    fireEvent.error(screen.getByAltText("One"));
    expect(screen.getByText("Image unavailable")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByAltText("Two")).toBeTruthy();
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByText(/Animal one long-caption/)).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("traps focus without taking arrow keys from focused controls", async () => {
    const user = userEvent.setup();
    render(
      <ImageLightbox
        images={[
          { imageUrl: "/one.jpg", alt: "One", caption: "Animal one" },
          { imageUrl: "/two.jpg", alt: "Two", caption: "Animal two" },
        ]}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close fullscreen image" });
    const next = screen.getByRole("button", { name: "Next image" });

    await user.tab();
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "ArrowRight" });
    expect(screen.getByText("Animal one")).toBeTruthy();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(next);
    await user.tab();
    expect(document.activeElement).toBe(close);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("restores focus and body overflow when the lightbox closes", async () => {
    function LightboxHarness() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open fox photo
          </button>
          {isOpen ? (
            <ImageLightbox imageUrl="/fox.jpg" alt="Fox" onClose={() => setIsOpen(false)} />
          ) : null}
        </>
      );
    }

    document.body.style.overflow = "clip";
    render(<LightboxHarness />);
    const trigger = screen.getByRole("button", { name: "Open fox photo" });
    await userEvent.click(trigger);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(document.body.style.overflow).toBe("clip");
    document.body.style.overflow = "";
  });
});
