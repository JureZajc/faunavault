import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import ArchivePhotoMap, { createPhotoPopup } from "../app/components/maps/archive-photo-map.client";
import { PhotoMapPoint } from "../app/lib/api";

type ClusterOptions = { chunkProgress: (processed: number, total: number) => void; spiderfyOnMaxZoom: boolean; chunkedLoading: boolean };
type MockMarker = { coordinates: number[]; events: Record<string, () => void>; off: ReturnType<typeof vi.fn>; openPopup: ReturnType<typeof vi.fn> };
type MockCluster = { options: ClusterOptions; addLayers: ReturnType<typeof vi.fn>; clearLayers: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };

const fake = vi.hoisted(() => {
  const map = {
    hasLayer: () => true, setView: vi.fn(), fitBounds: vi.fn(), closePopup: vi.fn(),
    _events: { moveend: [] as Array<{ fn: () => void; ctx: unknown }> },
    off: vi.fn(),
  };
  return { map, createMap: vi.fn(() => map), destroyMap: vi.fn(),
    selectionDisposed: vi.fn(),
    clusters: [] as MockCluster[], markers: [] as MockMarker[], rectangles: [] as Array<{ remove: ReturnType<typeof vi.fn> }> };
});
vi.mock("leaflet.markercluster", () => ({}));
vi.mock("../app/components/maps/leaflet-area-selection", async (original) => ({
  ...await original<typeof import("../app/components/maps/leaflet-area-selection")>(),
  attachAreaSelection: () => {
    let disposed = false;
    return () => { if (!disposed) { disposed = true; fake.selectionDisposed(); } };
  },
}));
vi.mock("leaflet", () => ({ default: {
  latLngBounds: (points: unknown) => points,
  rectangle: (bounds: unknown) => {
    const rectangle = { addTo: () => rectangle, getBounds: () => bounds, remove: vi.fn() };
    fake.rectangles.push(rectangle); return rectangle;
  },
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
beforeEach(() => {
  vi.clearAllMocks(); fake.clusters.length = 0; fake.markers.length = 0; fake.rectangles.length = 0;
  fake.map._events.moveend = [];
  fake.map.off.mockImplementation((type: string, fn: () => void, ctx: unknown) => {
    if (type === "moveend") fake.map._events.moveend = fake.map._events.moveend.filter((listener) => listener.fn !== fn || listener.ctx !== ctx);
  });
});

test("filter replacement detaches pending cluster focus callbacks before markers lose their parents", () => {
  const points = [point(1), point(2)];
  const view = render(<ArchivePhotoMap points={points} focusPhotoId={null} />);
  const retired = fake.clusters[0];
  const staleFocus = vi.fn(() => {
    if (retired.clearLayers.mock.calls.length) throw new Error("Retired marker parent was deleted");
  });
  const otherLayerMove = vi.fn();
  fake.map._events.moveend = [
    { fn: staleFocus, ctx: retired },
    { fn: otherLayerMove, ctx: {} },
  ];
  view.rerender(<ArchivePhotoMap points={[point(2)]} focusPhotoId={null} />);
  expect(fake.map.off.mock.invocationCallOrder[0]).toBeLessThan(retired.clearLayers.mock.invocationCallOrder[0]);
  act(() => fake.map._events.moveend.forEach((listener) => listener.fn()));
  expect(staleFocus).not.toHaveBeenCalled();
  expect(otherLayerMove).toHaveBeenCalledOnce();
  view.unmount();
});

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

test("unmount restores active selection handlers before destroying Leaflet", () => {
  const view = render(<ArchivePhotoMap points={[point(1)]} focusPhotoId={null} selecting />);
  view.unmount();
  expect(fake.selectionDisposed).toHaveBeenCalledTimes(1);
  expect(fake.selectionDisposed.mock.invocationCallOrder[0]).toBeLessThan(fake.destroyMap.mock.invocationCallOrder[0]);
});

test("restored crossing rectangles wrap markers and focus together, then replace and clean up without map recreation", () => {
  const points = [{ ...point(1, 5), longitude: -179 }, { ...point(2, 5), longitude: 179 }];
  const area = { bbox_south: 0, bbox_north: 10, bbox_west: 170, bbox_east: -170 };
  const view = render(<ArchivePhotoMap points={points} focusPhotoId={1} area={area} mapHref="/map?catalog_bbox_west=170" />);
  expect(fake.markers[0].coordinates).toEqual([5, 181]);
  expect(fake.markers[1].coordinates).toEqual([5, 179]);
  expect(fake.map.setView).toHaveBeenCalledWith([5, 181], 16);
  const originalRectangle = fake.rectangles[0];
  view.rerender(<ArchivePhotoMap points={points} focusPhotoId={null} area={{ ...area, bbox_south: 1 }} />);
  expect(originalRectangle.remove).toHaveBeenCalledTimes(1);
  expect(fake.createMap).toHaveBeenCalledTimes(1);
  view.rerender(<ArchivePhotoMap points={points} focusPhotoId={null} />);
  expect(fake.rectangles[1].remove).toHaveBeenCalledTimes(1);
  expect(fake.markers.at(-2)?.coordinates).toEqual([5, -179]);
  view.unmount();
  expect(fake.destroyMap).toHaveBeenCalledTimes(1);
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
