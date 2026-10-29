import L from "leaflet";
import { AreaBounds, boundsError, boundsFromCorners, displayAreaBounds } from "../../lib/geographic-bounds";

export const AREA_STYLE: L.PathOptions = {
  color: "#9a3412", weight: 3, dashArray: "8 5", fillColor: "#f59e0b", fillOpacity: 0.15, interactive: false,
};

/** One bounded draft layer; pointer capture also handles a release outside the map. */
export function attachAreaSelection(map: L.Map, onSelect: (area: AreaBounds) => void, onError: (error: string) => void) {
  const container = map.getContainer();
  map.stop();
  const handlers = [map.dragging, map.touchZoom, map.doubleClickZoom, map.boxZoom, map.scrollWheelZoom, map.keyboard];
  const enabled = handlers.filter((handler) => handler.enabled());
  enabled.forEach((handler) => handler.disable());
  const oldCursor = container.style.cursor;
  const oldTouchAction = container.style.touchAction;
  container.style.cursor = "crosshair";
  container.style.touchAction = "none";
  let first: L.LatLng | null = null;
  let down: { point: L.LatLng; x: number; y: number; id: number } | null = null;
  let dragged = false;
  let draft: L.Rectangle | null = null;
  const draw = (a: L.LatLng, b: L.LatLng) => {
    const bounds = displayAreaBounds(boundsFromCorners(a, b));
    if (!draft) draft = L.rectangle(bounds, AREA_STYLE).addTo(map);
    else draft.setBounds(bounds);
  };
  const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const onDown = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest(".leaflet-control")) return;
    stop(event);
    down = { point: map.mouseEventToLatLng(event), x: event.clientX, y: event.clientY, id: event.pointerId };
    dragged = false;
    container.setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (down && down.id === event.pointerId) {
      stop(event);
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) dragged = true;
      if (dragged) draw(first ?? down.point, map.mouseEventToLatLng(event));
    } else if (first && event.pointerType === "mouse") draw(first, map.mouseEventToLatLng(event));
  };
  const onUp = (event: PointerEvent) => {
    if (!down || down.id !== event.pointerId) return;
    stop(event);
    const point = map.mouseEventToLatLng(event);
    const anchor = first ?? (dragged ? down.point : null);
    down = null;
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    if (!anchor) {
      first = point;
      draw(point, point);
      return;
    }
    const area = boundsFromCorners(anchor, point);
    const error = boundsError(area);
    if (error) { onError(error); return; }
    first = null;
    onSelect(area);
  };
  const onCancel = () => { down = null; first = null; draft?.remove(); draft = null; };
  const onClick = (event: Event) => {
    if (!(event.target as Element).closest(".leaflet-control")) stop(event);
  };
  container.addEventListener("pointerdown", onDown, true);
  container.addEventListener("pointermove", onMove, true);
  container.addEventListener("pointerup", onUp, true);
  container.addEventListener("pointercancel", onCancel, true);
  container.addEventListener("click", onClick, true);
  container.addEventListener("dblclick", onClick, true);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (down && container.hasPointerCapture(down.id)) container.releasePointerCapture(down.id);
    container.removeEventListener("pointerdown", onDown, true);
    container.removeEventListener("pointermove", onMove, true);
    container.removeEventListener("pointerup", onUp, true);
    container.removeEventListener("pointercancel", onCancel, true);
    container.removeEventListener("click", onClick, true);
    container.removeEventListener("dblclick", onClick, true);
    draft?.remove();
    container.style.cursor = oldCursor;
    container.style.touchAction = oldTouchAction;
    enabled.forEach((handler) => handler.enable());
  };
}
