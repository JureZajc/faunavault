import type L from "leaflet";

export function detachClusterMoveListeners(map: L.Map, cluster: L.MarkerClusterGroup) {
  // zoomToShowLayer can leave a moveend callback reading a marker's __parent
  // after clearLayers deletes it. Leaflet has no context-only off() method.
  const listeners = (map as L.Map & {
    _events?: { moveend?: Array<{ fn: L.LeafletEventHandlerFn; ctx: unknown }> };
  })._events?.moveend;
  for (const listener of [...(listeners ?? [])]) {
    if (listener.ctx === cluster) map.off("moveend", listener.fn, cluster);
  }
}
