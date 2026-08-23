"use client";

import L from "leaflet";
import { useEffect, useRef } from "react";
import { PHOTO_MAP_ZOOM } from "../../lib/map-config";
import {
  createLeafletMap,
  createPhotoMarkerIcon,
  destroyLeafletMap,
  labelMarker,
  observeMapSize,
} from "./leaflet-map-core";
import styles from "./photo-map.module.css";

export type SinglePhotoMapProps = {
  latitude: number;
  longitude: number;
  label: string;
};

export default function SinglePhotoMap({
  latitude,
  longitude,
  label,
}: SinglePhotoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = createLeafletMap(container, { scrollWheelZoom: false });
    const marker = L.marker([latitude, longitude], {
      alt: label,
      title: label,
      keyboard: true,
      icon: createPhotoMarkerIcon(),
    }).addTo(map);
    const popup = document.createElement("div");
    popup.textContent = label;
    marker.bindPopup(popup);
    const removeLabel = labelMarker(marker, label);
    map.setView([latitude, longitude], PHOTO_MAP_ZOOM);
    const stopObserving = observeMapSize(map, container);

    return () => {
      stopObserving();
      removeLabel();
      marker.off();
      marker.remove();
      destroyLeafletMap(map);
    };
  }, [label, latitude, longitude]);

  return (
    <div
      role="region"
      aria-label={`Interactive map showing the location of ${label}`}
      className={`${styles.frame} ${styles.detailFrame}`}
    >
      <div ref={containerRef} className={styles.canvas} />
    </div>
  );
}
