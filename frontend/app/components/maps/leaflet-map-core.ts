import L from "leaflet";
import { MAP_TILE_CONFIG } from "../../lib/map-config";
import styles from "./photo-map.module.css";

export function createLeafletMap(
  container: HTMLElement,
  options: { scrollWheelZoom: boolean },
) {
  const map = L.map(container, {
    center: [0, 0],
    zoom: 2,
    keyboard: true,
    scrollWheelZoom: options.scrollWheelZoom,
  });
  L.tileLayer(MAP_TILE_CONFIG.url, {
    attribution: MAP_TILE_CONFIG.attribution,
    maxZoom: MAP_TILE_CONFIG.maxZoom,
  }).addTo(map);
  return map;
}

export function createPhotoMarkerIcon() {
  return L.divIcon({
    className: styles.photoMarkerIcon,
    html: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

export function labelMarker(marker: L.Marker, label: string) {
  const applyLabel = () => {
    const element = marker.getElement();
    if (!element) return;
    element.setAttribute("role", "button");
    element.setAttribute("aria-label", label);
  };
  marker.on("add", applyLabel);
  return () => marker.off("add", applyLabel);
}

export function observeMapSize(map: L.Map, container: HTMLElement) {
  let frame = window.requestAnimationFrame(() => map.invalidateSize(false));
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => map.invalidateSize(false));
  });
  observer.observe(container);
  return () => {
    observer.disconnect();
    window.cancelAnimationFrame(frame);
  };
}

export function destroyLeafletMap(map: L.Map) {
  map.off();
  map.remove();
}
