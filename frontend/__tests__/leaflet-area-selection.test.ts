import L from "leaflet";
import { beforeEach, expect, test, vi } from "vitest";
import { attachAreaSelection } from "../app/components/maps/leaflet-area-selection";

const fake = vi.hoisted(() => ({ rectangles: [] as Array<{ setBounds: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }>, rectangle: vi.fn() }));
vi.mock("leaflet", () => ({ default: { rectangle: fake.rectangle } }));

beforeEach(() => {
  vi.clearAllMocks(); fake.rectangles.length = 0;
  fake.rectangle.mockImplementation(() => {
    const layer = { addTo: () => layer, setBounds: vi.fn(), remove: vi.fn() };
    fake.rectangles.push(layer); return layer;
  });
});

function setup() {
  const container = document.createElement("div");
  container.setPointerCapture = vi.fn(); container.releasePointerCapture = vi.fn(); container.hasPointerCapture = () => true;
  const handler = (initial = true) => {
    let enabled = initial;
    return { enabled: () => enabled, disable: vi.fn(() => { enabled = false; }), enable: vi.fn(() => { enabled = true; }) };
  };
  const map = { stop: vi.fn(), getContainer: () => container, mouseEventToLatLng: (event: PointerEvent) => ({ lat: event.clientY, lng: event.clientX }),
    dragging: handler(), touchZoom: handler(), doubleClickZoom: handler(), boxZoom: handler(), scrollWheelZoom: handler(false), keyboard: handler() };
  const select = vi.fn(); const error = vi.fn();
  const cleanup = attachAreaSelection(map as unknown as L.Map, select, error);
  const pointer = (type: string, x: number, y: number, pointerType = "mouse") => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, pointerType });
    container.dispatchEvent(event);
  };
  return { container, map, select, error, cleanup, pointer };
}

test("drag shows one draft rectangle and confirms inclusive normalized bounds", () => {
  const { pointer, select, map, cleanup } = setup();
  expect(map.dragging.enabled()).toBe(false);
  pointer("pointerdown", 10, 1); pointer("pointermove", 20, 9); pointer("pointermove", 21, 10);
  expect(fake.rectangle).toHaveBeenCalledTimes(1);
  expect(fake.rectangles[0].setBounds).toHaveBeenCalledWith([[1, 10], [10, 21]]);
  pointer("pointerup", 21, 10);
  expect(select).toHaveBeenCalledWith({ bbox_south: 1, bbox_north: 10, bbox_west: 10, bbox_east: 21 });
  cleanup(); expect(fake.rectangles[0].remove).toHaveBeenCalledTimes(1);
  cleanup(); expect(fake.rectangles[0].remove).toHaveBeenCalledTimes(1);
  expect(map.dragging.enabled()).toBe(true);
  expect(map.dragging.enable).toHaveBeenCalledTimes(1);
  expect(map.scrollWheelZoom.enable).not.toHaveBeenCalled();
});

test("mobile taps choose opposite corners, with no selection after only one tap", () => {
  const { pointer, select, cleanup } = setup();
  pointer("pointerdown", 170, 1, "touch"); pointer("pointerup", 170, 1, "touch");
  expect(select).not.toHaveBeenCalled();
  pointer("pointerdown", 190, 10, "touch"); pointer("pointerup", 190, 10, "touch");
  expect(select).toHaveBeenCalledWith({ bbox_south: 1, bbox_north: 10, bbox_west: 170, bbox_east: -170 });
  cleanup();
});

test("zero size reports an error; cancellation and cleanup remove listeners and layers", () => {
  const { pointer, select, error, cleanup, container } = setup();
  const remove = vi.spyOn(container, "removeEventListener");
  pointer("pointerdown", 10, 1); pointer("pointerup", 10, 1);
  pointer("pointerdown", 10, 1); pointer("pointerup", 10, 1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("South latitude"));
  pointer("pointercancel", 10, 1);
  expect(fake.rectangles[0].remove).toHaveBeenCalled();
  cleanup();
  expect(remove).toHaveBeenCalledTimes(6);
  pointer("pointerdown", 10, 1); pointer("pointermove", 20, 10); pointer("pointerup", 20, 10);
  expect(select).not.toHaveBeenCalled();
  expect(container.style.cursor).toBe("");
  expect(container.style.touchAction).toBe("");
});
