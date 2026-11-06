import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SightingMapClient, { createSightingPopup } from "../app/components/maps/sighting-map.client";
import type { SightingMapPoint } from "../app/lib/api";

const fake = vi.hoisted(() => {
  const map = {
    setView: vi.fn(), fitBounds: vi.fn(), off: vi.fn(),
    _events: { moveend: [] as Array<{ fn: () => void; ctx: unknown }> },
  };
  const makeMarker = vi.fn((coordinates: number[]) => ({
    getLatLng: () => coordinates, bindPopup: vi.fn().mockReturnThis(),
    openPopup: vi.fn(), unbindPopup: vi.fn(), off: vi.fn(),
  }));
  const makeCluster = vi.fn(() => ({
    addTo: vi.fn(), addLayers: vi.fn(), clearLayers: vi.fn(), off: vi.fn(), remove: vi.fn(),
    zoomToShowLayer: vi.fn((_marker: unknown, callback: () => void) => callback()),
  }));
  return { map, makeMarker, makeCluster, createMap: vi.fn(() => map), destroyMap: vi.fn(), stopObserving: vi.fn() };
});

vi.mock("leaflet.markercluster", () => ({}));
vi.mock("leaflet", () => ({ default: {
  marker: fake.makeMarker, markerClusterGroup: fake.makeCluster, latLngBounds: (bounds: unknown) => bounds,
} }));
vi.mock("../app/components/maps/leaflet-map-core", () => ({
  createLeafletMap: fake.createMap, destroyLeafletMap: fake.destroyMap,
  createPhotoMarkerIcon: () => ({}), labelMarker: () => vi.fn(), observeMapSize: () => fake.stopObserving,
}));

function point(id: number, changes: Partial<SightingMapPoint> = {}): SightingMapPoint {
  return { id, latitude: 0, longitude: 0, observed_at: "2026-08-23T23:58:00",
    subject_label: null, location_label: null, taxon_id: null, common_name: null, scientific_name: null,
    thumbnail_filename: null, ...changes };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.map._events.moveend = [];
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("popup safely renders labels, field-local observation date, optional photo and detail link", () => {
  const popup = createSightingPopup(point(3, {
    subject_label: "<script>subject</script>", location_label: "<img src=bad>", thumbnail_filename: "thumb.jpg",
  }));
  expect(popup.querySelector("script")).toBeNull();
  expect(popup.textContent).toContain("<script>subject</script>");
  expect(popup.textContent).toContain("<img src=bad>");
  expect(popup.querySelector("time")?.textContent).toBe("Aug 23, 2026");
  expect(popup.querySelector("a")?.getAttribute("href")).toBe("/sightings/3");
  const images = popup.querySelectorAll("img");
  expect(images).toHaveLength(1);
  expect(images[0].src).toMatch(/\/thumbs\/thumb\.jpg$/);
  images[0].dispatchEvent(new Event("error"));
  expect(popup.querySelector("img")).toBeNull();
  expect(createSightingPopup(point(4, { common_name: "Red fox" })).textContent).toContain("Red fox");
  expect(createSightingPopup(point(5, { scientific_name: "Vulpes vulpes" })).textContent).toContain("Vulpes vulpes");
  expect(createSightingPopup(point(6)).textContent).toContain("Unidentified sighting");
});

test("wraps antimeridian points together, projects polar latitude and opens the focused marker", () => {
  const view = render(<SightingMapClient points={[
    point(3, { latitude: 90, longitude: 179 }), point(4, { longitude: -179 }), point(5, { longitude: -179 }),
  ]} focusId={4} onAreaSelect={vi.fn()} />);
  expect(fake.makeMarker.mock.calls.map(([coords]) => coords)).toEqual([[85.0511287798, 179], [0, 181], [0, 181]]);
  expect(fake.map.setView).toHaveBeenCalledWith([0, 181], 16, { animate: false });
  expect(fake.makeCluster).toHaveBeenCalledWith(expect.objectContaining({ spiderfyOnMaxZoom: true, animate: false }));
  expect(fake.makeMarker.mock.results[1].value.openPopup).toHaveBeenCalledOnce();
  view.unmount();
});

test("cancels marker batches and detaches cluster callbacks before replacing markers, then destroys the map on unmount", () => {
  let pending: FrameRequestCallback | undefined;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { pending = callback; return 123; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const select = vi.fn();
  const view = render(<SightingMapClient points={Array.from({ length: 501 }, (_, index) => point(index + 1))} focusId={501} onAreaSelect={select} />);
  const retired = fake.makeCluster.mock.results[0].value;
  const listener = vi.fn();
  fake.map._events.moveend = [{ fn: listener, ctx: retired }, { fn: vi.fn(), ctx: {} }];
  expect(retired.addLayers.mock.calls[0][0]).toHaveLength(500);
  view.rerender(<SightingMapClient points={[point(2, { latitude: 33 })]} onAreaSelect={select} />);
  expect(cancel).toHaveBeenCalledWith(123);
  act(() => pending?.(0));
  expect(retired.addLayers).toHaveBeenCalledOnce();
  expect(retired.zoomToShowLayer).not.toHaveBeenCalled();
  expect(fake.map.off).toHaveBeenCalledExactlyOnceWith("moveend", listener, retired);
  expect(fake.map.off.mock.invocationCallOrder[0]).toBeLessThan(retired.clearLayers.mock.invocationCallOrder[0]);
  expect(fake.makeMarker.mock.calls.at(-1)?.[0]).toEqual([33, 0]);
  expect(fake.createMap).toHaveBeenCalledOnce();
  const current = fake.makeCluster.mock.results[1].value;
  view.unmount();
  expect(current.remove.mock.invocationCallOrder[0]).toBeLessThan(fake.destroyMap.mock.invocationCallOrder[0]);
  expect(fake.stopObserving).toHaveBeenCalledOnce();
  expect(fake.makeMarker.mock.results.every(({ value }) => value.unbindPopup.mock.calls.length === 1)).toBe(true);
});
