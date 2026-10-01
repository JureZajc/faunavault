import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import CompareBrowser from "../app/compare/compare-browser";
import CompareImage from "../app/compare/compare-image";
import { useComparePhoto } from "../app/hooks/use-compare-photo";
import { ApiError, Photo, PhotoUpdate } from "../app/lib/api";
import { compareHref, compareReturnLocation, parseComparePair } from "../app/lib/photo-compare";

const api = vi.hoisted(() => ({ getPhoto: vi.fn(), updatePhoto: vi.fn() }));
const navigation = vi.hoisted(() => ({ search: "left=1&right=2" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(navigation.search) }));
vi.mock("../app/lib/api", async (original) => ({ ...await original<typeof import("../app/lib/api")>(), ...api }));

function photo(id: number, values: Partial<Photo> = {}): Photo {
  return { id, original_filename: `fox-${id}.jpg`, culling_state: null, is_favorite: false, rating: null,
    stored_filename: `${id}.jpg`, resized_filename: `${id}-resized.jpg`, thumbnail_filename: `${id}-thumb.jpg`, display_title: `Fox ${id}`,
    common_name: "Fox", breed_guess: null, species_guess: "Vulpes vulpes", category: "mammal", confidence: null, description: null, tags: [], status: "needs_review", animal_id: null,
    content_sha256: null, original_size_bytes: id * 1048576, media_type: "image/jpeg", captured_at: "2024-05-24T18:42:00", captured_at_offset_minutes: 120,
    extracted_captured_at: null, extracted_captured_at_offset_minutes: null, extracted_latitude: null, extracted_longitude: null, capture_metadata_overridden: false, location_metadata_overridden: false,
    camera_make: "SONY", camera_model: "Alpha", lens_model: "50 mm", image_width: 640, image_height: 480, latitude: null, longitude: null,
    deleted_at: null, reviewed_at: null, created_at: "2026-09-01T12:00:00", updated_at: "2026-09-01T12:00:00", ...values };
}
let photos: Photo[];
beforeEach(() => {
  vi.resetAllMocks();
  navigation.search = "left=1&right=2";
  photos = [photo(1), photo(2)];
  api.getPhoto.mockImplementation(async (id: string) => ({ ...photos[Number(id) - 1] }));
  api.updatePhoto.mockImplementation(async (id: number, values: PhotoUpdate) => {
    photos[id - 1] = { ...photos[id - 1], ...values, updated_at: "2026-09-01T12:01:00" };
    return { ...photos[id - 1] };
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each(["", "right=2", "left=1", "left=1&right=1", "left=0&right=2", "left=1.2&right=2", "left=1&right=9007199254740992", "left=1&left=3&right=2", "left=1&right=2&right=3"])("invalid route %s requests no photos", async (query) => {
  navigation.search = query;
  render(<CompareBrowser />);
  expect(screen.getByRole("alert").textContent).toMatch(/Choose/);
  expect(api.getPhoto).not.toHaveBeenCalled();
});

test("pair URLs preserve identity and restrict return destinations", () => {
  expect(parseComparePair(new URLSearchParams("left=2&right=1")).pair).toEqual({ left: 2, right: 1 });
  expect(compareHref(2, 1, "/?catalog_page=2")).toBe("/compare?left=2&right=1&returnTo=%2F%3Fcatalog_page%3D2");
  for (const value of ["https://evil.test/", "//evil.test", "/\\evil.test", "/photos/1", "/%2f%2fevil.test", "/\n", "/compare?left=1"]) expect(compareReturnLocation(value)).toBe("/");
  expect(compareReturnLocation("/cull?photo=1&source=list")).toBe("/cull?photo=1&source=list");
});

test("both sides show targeted controls and metadata; independent curation never advances or couples decisions", async () => {
  render(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 1" });
  await screen.findByRole("heading", { name: "Fox 2" });
  expect(api.getPhoto).toHaveBeenCalledTimes(2);
  expect(api.getPhoto).toHaveBeenCalledWith("1", expect.any(AbortSignal));
  const left = screen.getByRole("region", { name: "Left photo" });
  const right = screen.getByRole("region", { name: "Right photo" });
  expect(within(left).getByText("640 × 480")).toBeTruthy();
  expect(within(right).getByText("2 MB")).toBeTruthy();
  expect(within(left).getByText("Differs")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Pick left photo" }));
  expect(api.updatePhoto).toHaveBeenLastCalledWith(1, { culling_state: "pick" }, "2026-09-01T12:00:00");
  await userEvent.click(screen.getByRole("button", { name: "Pick right photo" }));
  await userEvent.click(screen.getByRole("button", { name: "Reject right photo" }));
  await userEvent.click(screen.getByRole("button", { name: "Clear right photo decision" }));
  await userEvent.click(screen.getByRole("button", { name: "Favorite right photo" }));
  await userEvent.click(screen.getByRole("radio", { name: "Rate right photo 4 stars" }));
  await userEvent.click(screen.getByRole("button", { name: "Clear right photo rating" }));
  expect(photos[0]).toMatchObject({ culling_state: "pick", is_favorite: false, rating: null, status: "needs_review" });
  expect(photos[1]).toMatchObject({ culling_state: null, is_favorite: true, rating: null, status: "needs_review" });
  expect(screen.getByRole("heading", { name: "Fox 1" })).toBeTruthy();
});

test("the API's shared unavailable response for missing/trashed/deleted photos leaves the other side usable", async () => {
  api.getPhoto.mockImplementation(async (id: string) => { if (id === "2") throw new ApiError("Photo not found", 404); return photo(1); });
  render(<CompareBrowser />);
  await screen.findByText(/Photo no longer available/);
  await userEvent.click(screen.getByRole("button", { name: "Pick left photo" }));
  expect(api.updatePhoto).toHaveBeenCalledWith(1, { culling_state: "pick" }, expect.any(String));
  expect(screen.queryByRole("button", { name: "Pick right photo" })).toBeNull();
});

test("one pane can fail independently and retry while the other photo stays loaded", async () => {
  api.getPhoto.mockImplementation(async (id: string) => { if (id === "2") throw new Error("offline"); return photo(1); });
  render(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 1" });
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
  expect(screen.getByRole("button", { name: "Pick left photo" }).hasAttribute("disabled")).toBe(false);
  api.getPhoto.mockResolvedValueOnce(photo(2));
  await userEvent.click(screen.getByRole("button", { name: "Refresh right photo" }));
  await screen.findByRole("heading", { name: "Fox 2" });
  expect(screen.getByRole("heading", { name: "Fox 1" })).toBeTruthy();
});

test("a URL pair change aborts old requests and resets pane state; remount restores the same URL pair", async () => {
  let finish!: (photo: Photo) => void;
  api.getPhoto.mockImplementationOnce(() => new Promise<Photo>((resolve) => { finish = resolve; }));
  const view = render(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 2" });
  const signal = api.getPhoto.mock.calls[0][1] as AbortSignal;
  navigation.search = "left=2&right=3";
  photos.push(photo(3));
  view.rerender(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 3" });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(photo(1)); });
  expect(screen.queryByRole("heading", { name: "Fox 1" })).toBeNull();
  view.unmount();
  render(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 3" });
  expect(api.getPhoto).toHaveBeenLastCalledWith("3", expect.any(AbortSignal));
});

test("keyboard focus, independent actions and typing/native shortcut exclusions", async () => {
  render(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 2" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(screen.getByRole("button", { name: "Focus right photo", pressed: true })).toBeTruthy();
  fireEvent.keyDown(window, { key: "p" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Pick right photo", pressed: true })).toBeTruthy());
  fireEvent.keyDown(window, { key: "4" });
  await waitFor(() => expect(screen.getByRole<HTMLInputElement>("radio", { name: "Rate right photo 4 stars" }).checked).toBe(true));
  fireEvent.keyDown(window, { key: "f" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Favorite right photo", pressed: true })).toBeTruthy());
  const calls = api.updatePhoto.mock.calls.length;
  const input = document.createElement("input"); document.body.append(input); fireEvent.keyDown(input, { key: "x" }); input.remove();
  const editable = document.createElement("div"); editable.setAttribute("contenteditable", "true"); document.body.append(editable); fireEvent.keyDown(editable, { key: "x" }); editable.remove();
  for (const options of [{ repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) fireEvent.keyDown(window, { key: "x", ...options });
  const modal = document.createElement("div"); modal.setAttribute("aria-modal", "true"); document.body.append(modal); fireEvent.keyDown(window, { key: "x" }); modal.remove();
  fireEvent.keyDown(screen.getByRole("radio", { name: "Rate right photo 4 stars" }), { key: "ArrowLeft" });
  fireEvent.keyDown(screen.getByRole("region", { name: "right photo image viewport" }), { key: "ArrowLeft" });
  expect(screen.getByRole("button", { name: "Focus right photo", pressed: true })).toBeTruthy();
  expect(api.updatePhoto).toHaveBeenCalledTimes(calls);
  fireEvent.keyDown(window, { key: "u" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Pick right photo", pressed: false })).toBeTruthy());
  fireEvent.keyDown(window, { key: "0" });
  await waitFor(() => expect(photos[1].rating).toBeNull());
});

test("refresh clears externally deleted data and failed refresh disables saves until retried", async () => {
  const { result } = renderHook(() => useComparePhoto(1));
  await waitFor(() => expect(result.current.photo?.id).toBe(1));
  api.getPhoto.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.stale).toBe(true);
  await act(async () => { await result.current.save({ rating: 5 }); });
  expect(api.updatePhoto).not.toHaveBeenCalled();
  await act(async () => { await result.current.refresh(); });
  expect(result.current.stale).toBe(false);
  api.getPhoto.mockRejectedValueOnce(new ApiError("Photo not found", 404));
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(result.current.unavailable).toBe(true));
  expect(result.current.photo).toBeNull();
});

test("conflicts reload confirmed state without repeating the mutation; saves block overlapping actions", async () => {
  const { result } = renderHook(() => useComparePhoto(1));
  await waitFor(() => expect(result.current.photo?.id).toBe(1));
  photos[0] = photo(1, { rating: 3, updated_at: "2026-09-01T12:02:00" });
  api.updatePhoto.mockRejectedValueOnce(new ApiError("Photo changed. Refresh before saving.", 409));
  await act(async () => { await result.current.save({ culling_state: "pick" }); });
  expect(result.current.photo?.rating).toBe(3);
  expect(result.current.error).toMatch(/Photo changed/);
  expect(api.updatePhoto).toHaveBeenCalledTimes(1);
  let finish!: (photo: Photo) => void;
  api.updatePhoto.mockImplementationOnce(() => new Promise<Photo>((resolve) => { finish = resolve; }));
  act(() => { void result.current.save({ culling_state: "pick" }); void result.current.save({ culling_state: "reject" }); });
  expect(result.current.busy).toBe(true);
  await act(async () => { await result.current.refresh(); });
  expect(api.getPhoto).toHaveBeenCalledTimes(2);
  await act(async () => { finish(photo(1, { culling_state: "pick" })); });
  expect(api.updatePhoto).toHaveBeenCalledTimes(2);
  expect(result.current.photo?.culling_state).toBe("pick");
});

test("a photo removed during a save clears the old image and controls", async () => {
  render(<CompareBrowser />);
  await screen.findByRole("heading", { name: "Fox 1" });
  api.updatePhoto.mockRejectedValueOnce(new ApiError("Photo not found", 404));
  await userEvent.click(screen.getByRole("button", { name: "Pick left photo" }));
  await screen.findByText(/Photo no longer available/);
  expect(screen.queryByRole("img", { name: "Left photo: Fox 1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pick left photo" })).toBeNull();
  expect(screen.getByRole("button", { name: "Pick right photo" })).toBeTruthy();
});

test("bounded refresh polls only when visible, refreshes on visibility, and older refreshes cannot replace a save", async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useComparePhoto(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.photo?.id).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(api.getPhoto).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(api.getPhoto).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(api.getPhoto).toHaveBeenCalledTimes(3);
  let finish!: (photo: Photo) => void;
  api.getPhoto.mockImplementationOnce(() => new Promise<Photo>((resolve) => { finish = resolve; }));
  act(() => { void result.current.refresh(); });
  const signal = api.getPhoto.mock.calls.at(-1)![1] as AbortSignal;
  await act(async () => { await result.current.save({ culling_state: "pick" }); });
  expect(signal.aborted).toBe(true);
  await act(async () => { finish(photo(1)); });
  expect(result.current.photo?.culling_state).toBe("pick");
});

test("independent zoom, pan and reset use previews; explicit originals keep previews until decoded", async () => {
  const originals: HTMLImageElement[] = [];
  vi.stubGlobal("Image", function () { const image = document.createElement("img"); originals.push(image); return image; });
  render(<><CompareImage photo={photo(1)} side="left" /><CompareImage photo={photo(2)} side="right" /></>);
  const leftImage = screen.getByRole("img", { name: "Left photo: Fox 1" });
  expect(leftImage.getAttribute("src")).toContain("/images/resized/");
  expect(originals).toHaveLength(0);
  Object.defineProperties(leftImage, { naturalWidth: { value: 1600 }, naturalHeight: { value: 1200 } });
  fireEvent.load(leftImage);
  await userEvent.click(screen.getByRole("button", { name: "Zoom in left photo" }));
  expect(screen.getByLabelText("left photo zoom").textContent).toBe("1.5× fit");
  expect(screen.getByLabelText("right photo zoom").textContent).toBe("Fit");
  const viewport = screen.getByRole("region", { name: "left photo image viewport" });
  viewport.scrollBy = vi.fn(); viewport.scrollTo = vi.fn();
  await userEvent.click(screen.getByRole("button", { name: "Pan left photo right" }));
  expect(viewport.scrollBy).toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Fit / reset left photo" }));
  expect(viewport.scrollTo).toHaveBeenCalledWith({ left: 0, top: 0 });
  await userEvent.click(screen.getByRole("button", { name: "Load left photo original resolution" }));
  expect(originals).toHaveLength(1);
  expect(leftImage.getAttribute("src")).toContain("/images/resized/");
  fireEvent.error(originals[0]);
  expect(screen.getByText("Original unavailable; showing preview.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Load left photo original resolution" }));
  fireEvent.load(originals[1]);
  expect(leftImage.getAttribute("src")).toContain("/images/original/");
});

test("HEIC uses its JPEG derivative; missing resized uses a thumbnail and image failure never requests an original", () => {
  const view = render(<CompareImage photo={photo(1, { stored_filename: "1.heic", media_type: "image/heic" })} side="left" />);
  expect(screen.queryByRole("button", { name: "Load left photo original resolution" })).toBeNull();
  expect(screen.getByText(/up to 1600 px/)).toBeTruthy();
  view.rerender(<CompareImage key="thumb" photo={photo(1, { resized_filename: "" })} side="left" />);
  const image = screen.getByRole("img");
  expect(image.getAttribute("src")).toContain("/images/thumbs/");
  fireEvent.error(image);
  expect(screen.getByText("Image unavailable")).toBeTruthy();
});
