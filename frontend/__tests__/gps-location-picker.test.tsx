import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import GpsLocationPicker from "../app/components/maps/gps-location-picker";
import type { GpsCoordinates } from "../app/components/maps/gps-picker-map.client";

const fake = vi.hoisted(() => ({
  events: {} as Record<string, (event?: unknown) => void>,
  tileEvents: {} as Record<string, () => void>,
  markerEvents: {} as Record<string, () => void>,
  setView: vi.fn(), panTo: vi.fn(), setLatLng: vi.fn(), marker: vi.fn(),
  markerOff: vi.fn(), markerRemove: vi.fn(), destroy: vi.fn(), stop: vi.fn(),
  create: vi.fn(), position: { lat: 0, lng: 0 }, renderFailure: false, loading: false,
}));
vi.mock("next/dynamic", async () => {
  const { default: Map } = await import("../app/components/maps/gps-picker-map.client");
  return { default: (_loader: unknown, options: { loading: () => React.ReactNode }) => function DynamicMap(props: React.ComponentProps<typeof Map>) {
    if (fake.loading) return options.loading();
    if (fake.renderFailure) throw new Error("Map chunk failed");
    return <Map {...props} />;
  } };
});
vi.mock("leaflet", () => {
  class TileLayer {
    on(name: string, fn: () => void) { fake.tileEvents[name] = fn; }
    off(name: string) { delete fake.tileEvents[name]; }
  }
  return { default: { TileLayer, marker: (coordinates: number[], options: unknown) => {
    fake.marker(coordinates, options);
    return {
      addTo() { return this; },
      on(name: string, fn: () => void) { fake.markerEvents[name] = fn; },
      off: fake.markerOff, remove: fake.markerRemove, setLatLng: fake.setLatLng,
      getLatLng: () => position(fake.position.lat, fake.position.lng),
    };
  } } };
});
vi.mock("../app/components/maps/leaflet-map-core", async () => {
  const { default: L } = await import("leaflet");
  return {
    createLeafletMap: fake.create,
    destroyLeafletMap: fake.destroy,
    observeMapSize: () => fake.stop,
    labelMarker: vi.fn(), createPhotoMarkerIcon: () => ({}),
    mockMap: { setView: fake.setView, panTo: fake.panTo,
      eachLayer: (fn: (layer: unknown) => void) => fn(new L.TileLayer("")),
      on: (name: string, fn: (event?: unknown) => void) => { fake.events[name] = fn; },
    },
  };
});

function position(lat: number, lng: number) {
  return { wrap: () => ({ lat, lng: lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng }) };
}
const changed = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  fake.events = {}; fake.tileEvents = {}; fake.markerEvents = {}; fake.renderFailure = false; fake.loading = false;
  const core = await import("../app/components/maps/leaflet-map-core") as unknown as { mockMap: unknown };
  fake.create.mockReturnValue(core.mockMap);
});
async function open(latitude = "", longitude = "") {
  const view = render(<GpsLocationPicker latitude={latitude} longitude={longitude} onChange={changed} />);
  await userEvent.click(screen.getByRole("button", { name: "Choose on map" }));
  return view;
}

test("empty picker requires explicit selection; clicking and dragging synchronize full precision coordinates", async () => {
  await open();
  expect(fake.setView).not.toHaveBeenCalled();
  expect(fake.marker).not.toHaveBeenCalled();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Use this location" }).disabled).toBe(true);
  act(() => fake.events.click({ latlng: position(-46.123456789, 181.23456789) }));
  expect(screen.getByLabelText<HTMLInputElement>("Latitude").value).toBe("-46.123456789");
  expect(screen.getByLabelText<HTMLInputElement>("Longitude").value).toBe("-178.76543211");
  expect(fake.marker.mock.calls[0][1]).toMatchObject({ draggable: true, keyboard: true });
  act(() => fake.markerEvents.dragstart());
  fake.position = { lat: -12.3456789, lng: 179.9999999 };
  act(() => fake.markerEvents.drag());
  expect(screen.getByLabelText<HTMLInputElement>("Latitude").value).toBe("-12.3456789");
  fake.position = { lat: 0, lng: 0 };
  act(() => fake.markerEvents.dragend());
  expect(screen.getByRole("status").textContent).toBe("Selected: 0, 0");
  expect(fake.setLatLng).toHaveBeenLastCalledWith([0, 0]);
  expect(changed).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Use this location" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith({ latitude: 0, longitude: 0 });
});

test("existing coordinates initialize the view and marker and numeric edits reposition it without rebuilding", async () => {
  await open("46.123456789", "14.987654321");
  expect(fake.setView).toHaveBeenCalledWith([46.123456789, 14.987654321], 15);
  expect(fake.marker).toHaveBeenCalledWith([46.123456789, 14.987654321], expect.anything());
  fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "-90" } });
  fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "180" } });
  expect(fake.setLatLng).toHaveBeenLastCalledWith([-90, 180]);
  expect(fake.create).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole("button", { name: "Use this location" }));
  expect(changed).toHaveBeenCalledWith({ latitude: -90, longitude: 180 });
});

test.each([["91", "0"], ["0", "-181"], ["NaN", "0"], ["Infinity", "0"], ["0", ""], ["", ""]])("rejects invalid or incomplete pair %s,%s", async (lat, lon) => {
  await open(lat, lon);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Use this location" }).disabled).toBe(true);
  expect(fake.marker).not.toHaveBeenCalled();
});

test("Cancel and Escape discard edits, restore focus and clean up every opening", async () => {
  const view = await open("0", "0");
  fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "50" } });
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(changed).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose on map" }));
  expect(fake.destroy).toHaveBeenCalledTimes(1);
  expect(fake.stop).toHaveBeenCalledTimes(1);
  expect(fake.markerOff).toHaveBeenCalledTimes(1);
  expect(fake.markerRemove).toHaveBeenCalledTimes(1);
  expect(fake.tileEvents).toEqual({});
  await userEvent.click(screen.getByRole("button", { name: "Choose on map" }));
  expect(screen.getByLabelText<HTMLInputElement>("Latitude").value).toBe("0");
  await userEvent.keyboard("{Escape}");
  expect(fake.destroy).toHaveBeenCalledTimes(2);
  expect(document.body.style.overflow).toBe("");
  view.unmount();
});

test("keyboard entry is a complete alternative and traps focus without submitting the parent", async () => {
  const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(<form onSubmit={submit}><GpsLocationPicker latitude="" longitude="" onChange={changed} /></form>);
  await userEvent.click(screen.getByRole("button", { name: "Choose on map" }));
  expect(document.activeElement).toBe(screen.getByLabelText("Latitude"));
  await userEvent.type(screen.getByLabelText("Latitude"), "0");
  await userEvent.tab();
  await userEvent.keyboard("-123.123456789{Enter}");
  expect(submit).not.toHaveBeenCalled();
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use this location" }));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByLabelText("Latitude"));
  await userEvent.tab({ shift: true });
  await userEvent.keyboard("{Enter}");
  expect(changed).toHaveBeenCalledWith({ latitude: 0, longitude: -123.123456789 } satisfies GpsCoordinates);
});

test.each(["tiles", "initialization", "chunk"])("%s failure leaves manual confirmation usable", async (failure) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    if (failure === "initialization") fake.create.mockImplementationOnce(() => { throw new Error("Map failed"); });
    if (failure === "chunk") fake.renderFailure = true;
    await open();
    if (failure === "tiles") act(() => fake.tileEvents.tileerror());
    expect(screen.getByRole("alert").textContent).toContain("Map unavailable");
    fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "0" } });
    await userEvent.click(screen.getByRole("button", { name: "Use this location" }));
    expect(changed).toHaveBeenCalledWith({ latitude: 0, longitude: 0 });
  } finally { log.mockRestore(); }
});

test("nested modal consumes Escape while preserving outer dialog and its scroll lock", async () => {
  const outerKey = vi.fn();
  render(<div role="dialog" aria-label="Outer" onKeyDown={outerKey}><GpsLocationPicker latitude="" longitude="" onChange={changed} /></div>);
  await userEvent.click(screen.getByRole("button", { name: "Choose on map" }));
  const dialog = within(screen.getByRole("dialog", { name: "Choose GPS location" }));
  await userEvent.type(dialog.getByLabelText("Latitude"), "0");
  outerKey.mockClear();
  await userEvent.keyboard("{Escape}");
  expect(outerKey).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
});

test("lazy loading shows a status while numeric entry remains available", async () => {
  fake.loading = true;
  await open();
  expect(screen.getByText("Loading location picker map…").getAttribute("role")).toBe("status");
  expect(fake.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Latitude"), { target: { value: "90" } });
  fireEvent.change(screen.getByLabelText("Longitude"), { target: { value: "-180" } });
  await userEvent.click(screen.getByRole("button", { name: "Use this location" }));
  expect(changed).toHaveBeenCalledWith({ latitude: 90, longitude: -180 });
});

test("Strict Mode cleans up both map lifetimes", async () => {
  const view = render(<StrictMode><GpsLocationPicker latitude="0" longitude="0" onChange={changed} /></StrictMode>);
  expect(fake.create).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Choose on map" }));
  expect(fake.create).toHaveBeenCalledTimes(2);
  expect(fake.destroy).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(fake.destroy).toHaveBeenCalledTimes(2);
  expect(fake.stop).toHaveBeenCalledTimes(2);
  expect(fake.markerOff).toHaveBeenCalledTimes(2);
  expect(fake.markerRemove).toHaveBeenCalledTimes(2);
});
