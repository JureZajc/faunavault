import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import ArchivePhotoMap, { createPhotoPopup } from "../app/components/maps/archive-photo-map.client";
import { PhotoMapPoint } from "../app/lib/api";

type ClusterOptions = { chunkProgress: (processed: number, total: number) => void; spiderfyOnMaxZoom: boolean; chunkedLoading: boolean };
type MockMarker = { coordinates: number[]; events: Record<string, () => void>; off: ReturnType<typeof vi.fn>; openPopup: ReturnType<typeof vi.fn> };
type MockCluster = { options: ClusterOptions; addLayers: ReturnType<typeof vi.fn>; clearLayers: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

const fake = vi.hoisted(() => {
  const map = { hasLayer: () => true, setView: vi.fn(), fitBounds: vi.fn() };
  return { map, createMap: vi.fn(() => map), destroyMap: vi.fn(),
    clusters: [] as MockCluster[], markers: [] as MockMarker[] };
});
vi.mock("leaflet.markercluster", () => ({}));
vi.mock("leaflet", () => ({ default: {
  latLngBounds: (points: unknown) => points,
  marker: (coordinates: number[]) => {
    const events: Record<string, () => void> = {};
    const marker = { events, coordinates, on: vi.fn((name: string, fn: () => void) => { events[name] = fn; }),
      off: vi.fn(), bindPopup: vi.fn(), getLatLng: () => coordinates,
      openPopup: vi.fn(() => events.popupopen?.()) };
    fake.markers.push(marker);
    return marker;
  },
  markerClusterGroup: (options: ClusterOptions) => {
    const cluster = { options, hasLayer: () => true, addLayers: vi.fn((markers: unknown[]) => options.chunkProgress(markers.length, markers.length)),
      addTo: vi.fn(), clearLayers: vi.fn(), off: vi.fn(), remove: vi.fn(),
      zoomToShowLayer: vi.fn((_marker: unknown, callback: () => void) => callback()) };
    fake.clusters.push(cluster);
    return cluster;
  },
} }));
vi.mock("../app/components/maps/leaflet-map-core", () => ({
  createLeafletMap: fake.createMap, destroyLeafletMap: fake.destroyMap,
  createPhotoMarkerIcon: () => ({}), labelMarker: () => vi.fn(), observeMapSize: () => vi.fn(),
}));

function point(id: number, latitude = 0): PhotoMapPoint {
  return { id, latitude, longitude: 0, thumbnail_filename: "thumb.jpg", original_filename: `photo-${id}.jpg`,
    display_title: null, common_name: null, species_guess: null, captured_at: null };
}
beforeEach(() => { vi.clearAllMocks(); fake.clusters.length = 0; fake.markers.length = 0; });

test("updates clustered membership and GPS without recreating map or retaining retired callbacks", async () => {
  const view = render(<ArchivePhotoMap points={[point(1), point(2)]} focusPhotoId={1} />);
  await waitFor(() => expect(fake.markers[0].openPopup).toHaveBeenCalled());
  const retired = fake.clusters[0];
  view.rerender(<ArchivePhotoMap points={[point(2, 46)]} focusPhotoId={1} mapHref="/map?catalog_category=bird" />);
  expect(fake.createMap).toHaveBeenCalledTimes(1);
  expect(retired.clearLayers).toHaveBeenCalled();
  expect(retired.remove).toHaveBeenCalled();
  expect(fake.markers[2].coordinates).toEqual([46, 0]);
  expect(fake.markers[2].openPopup).not.toHaveBeenCalled();
  act(() => retired.options.chunkProgress(2, 2));
  view.rerender(<ArchivePhotoMap points={[]} focusPhotoId={1} />);
  expect(fake.createMap).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(fake.destroyMap).toHaveBeenCalledTimes(1);
  expect(fake.markers.every((marker) => marker.off.mock.calls.length === 1)).toBe(true);
});

test("retains a user-selected popup when its Photo survives filtering", async () => {
  const view = render(<ArchivePhotoMap points={[point(1), point(2)]} focusPhotoId={null} />);
  act(() => fake.markers[1].events.popupopen());
  view.rerender(<ArchivePhotoMap points={[point(2)]} focusPhotoId={null} />);
  await waitFor(() => expect(fake.markers[2].openPopup).toHaveBeenCalled());
  expect(fake.createMap).toHaveBeenCalledTimes(1);
  expect(fake.clusters[1].options.spiderfyOnMaxZoom).toBe(true);
});

test("popup uses safe text and keeps filters in focused detail return navigation", () => {
  const popup = createPhotoPopup({ ...point(3), display_title: "<script>unsafe</script>" }, "/map?catalog_category=bird");
  expect(popup.querySelector("script")).toBeNull();
  expect(popup.querySelector("img")?.loading).toBe("lazy");
  expect(popup.querySelector("a")?.getAttribute("href")).toBe("/photos/3?returnTo=%2Fmap%3Fcatalog_category%3Dbird%26photo%3D3");
});


test("cancels pending marker batches when a filter replaces the cluster layer", () => {
  let pending: FrameRequestCallback | undefined;
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { pending = callback; return 123; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  try {
    const view = render(<ArchivePhotoMap points={Array.from({ length: 501 }, (_, index) => point(index + 1))} focusPhotoId={null} />);
    const retired = fake.clusters[0];
    expect(retired.addLayers.mock.calls[0][0]).toHaveLength(500);
    expect(retired.options.chunkedLoading).toBe(false);
    const lateCallback = pending;
    view.rerender(<ArchivePhotoMap points={[point(9)]} focusPhotoId={null} />);
    expect(cancel).toHaveBeenCalledWith(123);
    act(() => lateCallback?.(0));
    expect(retired.addLayers).toHaveBeenCalledTimes(1);
    expect(fake.clusters[1].addLayers.mock.calls[0][0]).toHaveLength(1);
    view.unmount();
  } finally {
    frame.mockRestore(); cancel.mockRestore();
  }
});
