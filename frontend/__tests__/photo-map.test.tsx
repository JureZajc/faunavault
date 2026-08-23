import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import MapBrowser from "../app/map/map-browser";
import { PhotoMapPoint } from "../app/lib/api";
import {
  parsePhotoFocusId,
  photoMapCapturedDate,
  photoMapDetailHref,
  photoMapMarkerLabel,
  photoMapPointTitle,
} from "../app/lib/photo-map";

const api = vi.hoisted(() => ({
  getPhotoMapPoints: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

vi.mock("../app/components/maps/map-boundaries", () => ({
  ArchivePhotoMap: ({
    points,
    focusPhotoId,
  }: {
    points: PhotoMapPoint[];
    focusPhotoId: number | null;
  }) => (
    <div
      role="region"
      aria-label="Mock archive map"
      data-count={points.length}
      data-focus={focusPhotoId ?? ""}
    />
  ),
  PhotoLocationMap: () => null,
}));

function point(overrides: Partial<PhotoMapPoint> = {}): PhotoMapPoint {
  return {
    id: 17,
    latitude: 46.12345,
    longitude: 14.54321,
    thumbnail_filename: "roe-deer-thumb.jpg",
    original_filename: "roe-deer.jpg",
    display_title: "Woodland visitor",
    common_name: "Roe deer",
    species_guess: "Capreolus capreolus",
    captured_at: "2024-05-24T18:42:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/map");
});

test("parses only one positive safe focus ID", () => {
  expect(parsePhotoFocusId("17")).toBe(17);
  expect(parsePhotoFocusId("0")).toBeNull();
  expect(parsePhotoFocusId("-1")).toBeNull();
  expect(parsePhotoFocusId("17.5")).toBeNull();
  expect(parsePhotoFocusId(["17", "18"])).toBeNull();
  expect(parsePhotoFocusId("99999999999999999999")).toBeNull();
});

test("builds compact preview metadata and a focused return link", () => {
  const location = point();
  expect(photoMapPointTitle(location)).toBe("Woodland visitor");
  expect(photoMapMarkerLabel(location)).toBe(
    "Open map preview for Woodland visitor",
  );
  expect(photoMapCapturedDate(location)).toBe("May 24, 2024");
  expect(photoMapDetailHref(location)).toBe(
    "/photos/17?returnTo=%2Fmap%3Fphoto%3D17",
  );
  expect(
    photoMapPointTitle(
      point({ display_title: " ", common_name: null, original_filename: "fallback.jpg" }),
    ),
  ).toBe("fallback.jpg");
});

test("shows loading and then passes points plus focus to the map boundary", async () => {
  let resolvePoints: (points: PhotoMapPoint[]) => void = () => undefined;
  api.getPhotoMapPoints.mockReturnValue(
    new Promise<PhotoMapPoint[]>((resolve) => {
      resolvePoints = resolve;
    }),
  );
  render(<MapBrowser focusPhotoId={17} />);

  expect(screen.getByRole("status").textContent).toContain("Loading");
  resolvePoints([point(), point({ id: 18 })]);

  const map = await screen.findByRole("region", { name: "Mock archive map" });
  expect(map.getAttribute("data-count")).toBe("2");
  expect(map.getAttribute("data-focus")).toBe("17");
  expect(screen.getByText("2 geotagged photos")).toBeTruthy();
  expect(
    screen.getAllByRole("link").map((link) => link.textContent),
  ).toEqual(["List", "Map", "Albums", "Collections", "Trash"]);
  expect(screen.getByRole("link", { name: "Map" }).getAttribute("aria-current"))
    .toBe("page");
});

test("shows the purposeful empty state without mounting a map", async () => {
  api.getPhotoMapPoints.mockResolvedValue([]);
  render(<MapBrowser focusPhotoId={null} />);

  expect(await screen.findByText("No geotagged photos yet")).toBeTruthy();
  expect(
    screen.getByText("Photos with GPS metadata will appear here automatically."),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Mock archive map" })).toBeNull();
});

test("shows a safe error and retries the map request", async () => {
  api.getPhotoMapPoints
    .mockRejectedValueOnce(new Error("private backend detail"))
    .mockResolvedValueOnce([point()]);
  render(<MapBrowser focusPhotoId={999} />);

  expect(await screen.findByText("Could not load photo locations")).toBeTruthy();
  expect(screen.queryByText("private backend detail")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.getPhotoMapPoints).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("region", { name: "Mock archive map" })).toBeTruthy();
});
