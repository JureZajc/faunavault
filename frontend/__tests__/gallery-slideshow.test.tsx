import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import ImageLightbox from "../app/components/image-lightbox";
import PaginatedPhotoGallery from "../app/components/paginated-photo-gallery";
import { Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getCollection: vi.fn(), getCatalogPhotos: vi.fn(), getCullingWorkspace: vi.fn(),
}));
vi.mock("../app/lib/api", async (original) => ({
  ...await original<typeof import("../app/lib/api")>(), ...api,
}));

const images = [1, 2, 3].map((id) => ({ imageUrl: `/${id}.jpg`, alt: `Photo ${id}`, caption: `Caption ${id}` }));
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next image" }));
const previous = () => fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
const play = () => fireEvent.click(screen.getByRole("button", { name: "Play slideshow" }));
const loadImage = () => fireEvent.load(screen.getByRole("img"));
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function photo(id: number): Photo {
  return { id, original_filename: `photo-${id}.heic`, resized_filename: `resized-${id}.jpg`, deleted_at: null } as Photo;
}
function page(number: number, total = 97) {
  return {
    items: Array.from({ length: Math.min(48, Math.max(0, total - (number - 1) * 48)) }, (_, i) => photo((number - 1) * 48 + i + 1)),
    page: number, page_size: 48, total, total_pages: Math.ceil(total / 48),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  api.getCollection.mockImplementation(async (_id, number) => ({ photos: page(number) }));
  api.getCatalogPhotos.mockImplementation(async (query) => page(query.page));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("manual controls, arrow keys, captions and boundaries preserve existing viewer", () => {
  const close = vi.fn();
  render(<ImageLightbox images={images} onClose={close} />);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Previous image" }).getAttribute("aria-disabled")).toBe("true");
  next();
  expect(screen.getByText("Caption 2")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
  expect(screen.getByText("3 of 3")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next image" }).getAttribute("aria-disabled")).toBe("true");
  previous();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowLeft" });
  expect(screen.getByText("1 of 3")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test.each([3, 5, 10])("explicit playback uses %s seconds and waits for each image load", async (seconds) => {
  render(<ImageLightbox images={images} onClose={vi.fn()} />);
  await tick(20_000);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Slideshow interval"), { target: { value: String(seconds) } });
  play();
  await tick(20_000);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  loadImage();
  await tick(seconds * 1000 - 1);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  await tick(1);
  expect(screen.getByText("2 of 3")).toBeTruthy();
  await tick(20_000);
  expect(screen.getByText("2 of 3")).toBeTruthy();
  loadImage();
  await tick(seconds * 1000);
  expect(screen.getByText("3 of 3")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
  loadImage();
  await tick(20_000);
  expect(screen.getByText("3 of 3")).toBeTruthy();
});

test("pause, manual navigation and interval changes cancel the previous timeout", async () => {
  const view = render(<ImageLightbox images={images} onClose={vi.fn()} />);
  loadImage(); play();
  await tick(2000);
  fireEvent.change(screen.getByLabelText("Slideshow interval"), { target: { value: "10" } });
  await tick(5000);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause slideshow" }));
  await tick(20_000);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  play(); next(); loadImage();
  expect(screen.getByText("Paused")).toBeTruthy();
  play();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("focused playback and navigation controls keep Escape working when unavailable", async () => {
  const close = vi.fn();
  render(<ImageLightbox images={images.slice(0, 2)} onClose={close} />);
  loadImage();
  const playback = screen.getByRole("button", { name: "Play slideshow" });
  playback.focus();
  play(); await tick(5000);
  expect(playback.getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement).toBe(playback);
  fireEvent.keyDown(playback, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("hidden tab pauses and returning does not resume playback", async () => {
  render(<ImageLightbox images={images} onClose={vi.fn()} />);
  loadImage(); play();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.getByText("Paused")).toBeTruthy();
  hidden.mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange"));
  await tick(10_000);
  expect(screen.getByText("1 of 3")).toBeTruthy();
});

test("reduced motion disables transitions without starting playback", async () => {
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: remove })));
  const view = render(<ImageLightbox images={images} onClose={vi.fn()} />);
  expect(screen.getByText(/Reduced motion enabled/)).toBeTruthy();
  expect(screen.getByRole("img").className).toContain("motion-safe:transition-opacity");
  loadImage(); await tick(10_000);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  play(); await tick(5000);
  expect(screen.getByText("2 of 3")).toBeTruthy();
  view.unmount();
  expect(remove).toHaveBeenCalledOnce();
});

test("failed images pause playback, support retry and bounded manual skip", async () => {
  render(<ImageLightbox images={images} onClose={vi.fn()} />);
  play(); fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("Paused")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
  loadImage(); play(); await tick(5000);
  fireEvent.error(screen.getByRole("img"));
  fireEvent.click(screen.getByRole("button", { name: "Skip image" }));
  expect(screen.getByText("3 of 3")).toBeTruthy();
});

test("typing controls keep arrow keys and gallery keys never reach Culling listeners", () => {
  const outer = vi.fn();
  render(<div onKeyDown={outer}><ImageLightbox images={images} onClose={vi.fn()} /></div>);
  fireEvent.keyDown(screen.getByLabelText("Slideshow interval"), { key: "ArrowRight" });
  expect(screen.getByText("1 of 3")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "p" });
  expect(outer).not.toHaveBeenCalled();
});

test("Collection page transitions work in both directions without changing the URL", async () => {
  const url = window.location.href;
  render(<PaginatedPhotoGallery kind="collection" id={7} start={{ page: 1, index: 47 }} onClose={vi.fn()} />);
  await tick();
  expect(screen.getByText("48 of 97")).toBeTruthy();
  next(); await tick();
  expect(screen.getByText("49 of 97")).toBeTruthy();
  previous(); await tick();
  expect(screen.getByText("48 of 97")).toBeTruthy();
  expect(api.getCollection).toHaveBeenCalledTimes(2);
  expect(window.location.href).toBe(url);
  expect(screen.getByRole("img").getAttribute("src")).toContain("/images/resized/resized-48.jpg");
  expect(document.querySelectorAll("img")).toHaveLength(1);
});

test("a page failure pauses playback and Retry recovers the requested page", async () => {
  api.getCollection.mockResolvedValueOnce({ photos: page(1) }).mockRejectedValueOnce(new Error("Network unavailable"));
  render(<PaginatedPhotoGallery kind="collection" id={7} start={{ page: 1, index: 47 }} onClose={vi.fn()} />);
  await tick(); loadImage(); play(); await tick(5000);
  expect(screen.getByText("Network unavailable")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry page" }));
  await tick();
  expect(screen.getByText("49 of 97")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
});

test("Pause remains available during a slow page transition", async () => {
  let resolve!: (value: { photos: ReturnType<typeof page> }) => void;
  api.getCollection.mockResolvedValueOnce({ photos: page(1) })
    .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<PaginatedPhotoGallery kind="collection" id={7} start={{ page: 1, index: 47 }} onClose={vi.fn()} />);
  await tick(); loadImage(); play(); await tick(5000);
  const pause = screen.getByRole("button", { name: "Pause slideshow" });
  expect(pause.getAttribute("aria-disabled")).toBe("false");
  fireEvent.click(pause);
  await act(async () => resolve({ photos: page(2) }));
  loadImage(); await tick(10_000);
  expect(screen.getByText("49 of 97")).toBeTruthy();
  expect(screen.getByText("Paused")).toBeTruthy();
});

test("Skip page makes one bounded request when a position disappears", async () => {
  api.getCollection.mockResolvedValueOnce({ photos: page(1) }).mockResolvedValueOnce({ photos: { ...page(2), items: [] } });
  render(<PaginatedPhotoGallery kind="collection" id={7} start={{ page: 1, index: 47 }} onClose={vi.fn()} />);
  await tick(); next(); await tick();
  fireEvent.click(screen.getByRole("button", { name: "Skip page" }));
  await tick();
  expect(screen.getByText("97 of 97")).toBeTruthy();
  expect(api.getCollection).toHaveBeenCalledTimes(3);
});

test("cache retains at most three pages and refetches evicted pages", async () => {
  api.getCollection.mockImplementation(async (_id, number) => ({ photos: page(number, 145) }));
  render(<PaginatedPhotoGallery kind="collection" id={7} start={{ page: 1, index: 47 }} onClose={vi.fn()} />);
  await tick();
  for (let i = 0; i < 97; i++) { next(); await tick(); }
  expect(screen.getByText("145 of 145")).toBeTruthy();
  for (let i = 0; i < 97; i++) { previous(); await tick(); }
  expect(screen.getByText("48 of 145")).toBeTruthy();
  expect(api.getCollection.mock.calls.map((call) => call[1])).toEqual([1, 2, 3, 4, 1]);
});

test.each(["collection", "event"] as const)("empty %s retains a closable dialog", async (kind) => {
  api.getCollection.mockResolvedValue({ photos: page(1, 0) });
  api.getCatalogPhotos.mockResolvedValue(page(1, 0));
  const close = vi.fn();
  render(<PaginatedPhotoGallery kind={kind} id={7} start={{ page: 1, index: 0 }} onClose={close} />);
  await tick();
  expect(screen.getByText("No active Photos in this gallery.")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("Event cover location uses the existing member ordering and falls back when unavailable", async () => {
  api.getCullingWorkspace.mockResolvedValue({ matches_query: true, position: 60 });
  const view = render(<PaginatedPhotoGallery kind="event" id={7} start={{ page: 1, index: 0, photoId: 60 }} onClose={vi.fn()} />);
  await tick();
  expect(screen.getByText("60 of 97")).toBeTruthy();
  expect(api.getCatalogPhotos).toHaveBeenCalledWith(expect.objectContaining({ event_id: 7, page: 2, sort: "created_at", order: "desc" }), expect.any(AbortSignal));
  expect(api.getCatalogPhotos).toHaveBeenCalledTimes(1);
  api.getCullingWorkspace.mockResolvedValue({ matches_query: false, position: null });
  view.rerender(<PaginatedPhotoGallery kind="event" id={8} start={{ page: 1, index: 0, photoId: 60 }} onClose={vi.fn()} />);
  await tick();
  expect(screen.getByText("1 of 97")).toBeTruthy();
});

test("closing or switching context aborts requests and ignores late responses", async () => {
  let resolve!: (value: { photos: ReturnType<typeof page> }) => void;
  api.getCollection.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<PaginatedPhotoGallery kind="collection" id={7} start={{ page: 1, index: 0 }} onClose={vi.fn()} />);
  await tick();
  const signal = api.getCollection.mock.calls[0][3] as AbortSignal;
  view.rerender(<PaginatedPhotoGallery kind="collection" id={8} start={{ page: 2, index: 0 }} onClose={vi.fn()} />);
  await tick();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ photos: page(1) }));
  expect(screen.getByText("49 of 97")).toBeTruthy();
  const latest = api.getCollection.mock.calls[1][3] as AbortSignal;
  view.unmount();
  expect(latest.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
