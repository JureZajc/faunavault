"use client";

import L from "leaflet";
import "leaflet.markercluster";
import { useEffect, useRef } from "react";
import { imageUrl, PhotoMapPoint } from "../../lib/api";
import {
  ARCHIVE_BOUNDS_MAX_ZOOM,
  FOCUSED_PHOTO_ZOOM,
  PHOTO_MAP_ZOOM,
} from "../../lib/map-config";
import {
  photoMapCapturedDate,
  photoMapDetailHref,
  photoMapMarkerLabel,
  photoMapPointTitle,
} from "../../lib/photo-map";
import {
  createLeafletMap,
  createPhotoMarkerIcon,
  destroyLeafletMap,
  labelMarker,
  observeMapSize,
} from "./leaflet-map-core";
import styles from "./photo-map.module.css";

export type ArchivePhotoMapProps = {
  points: PhotoMapPoint[];
  focusPhotoId: number | null;
};

function appendText(
  parent: HTMLElement,
  className: string,
  value: string,
) {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = value;
  parent.append(element);
}

export function createPhotoPopup(point: PhotoMapPoint) {
  const title = photoMapPointTitle(point);
  const content = document.createElement("div");
  content.className = styles.popup;

  const image = document.createElement("img");
  image.className = styles.popupImage;
  image.src = imageUrl("thumbs", point.thumbnail_filename);
  image.alt = title;
  image.loading = "lazy";
  content.append(image);

  appendText(content, styles.popupTitle, title);
  if (title !== point.original_filename) {
    appendText(content, styles.popupMeta, point.original_filename);
  }
  const capturedDate = photoMapCapturedDate(point);
  if (capturedDate) {
    appendText(content, styles.popupMeta, `Taken ${capturedDate}`);
  }
  if (point.species_guess) {
    appendText(content, styles.popupMeta, point.species_guess);
  }

  const link = document.createElement("a");
  link.className = styles.popupLink;
  link.href = photoMapDetailHref(point);
  link.textContent = "Open photo";
  content.append(link);
  return content;
}

export default function ArchivePhotoMap({
  points,
  focusPhotoId,
}: ArchivePhotoMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let destroyed = false;
    let focusApplied = false;
    let focusTimer: number | null = null;
    const map = createLeafletMap(container, { scrollWheelZoom: true });
    const markersById = new Map<number, L.Marker>();
    const removeMarkerLabels: Array<() => void> = [];
    const cluster = L.markerClusterGroup({
      chunkedLoading: true,
      removeOutsideVisibleBounds: true,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: true,
      chunkProgress: (processed, total) => {
        if (processed !== total || focusApplied || focusPhotoId === null) return;
        const focused = markersById.get(focusPhotoId);
        if (!focused) return;
        focusApplied = true;
        // markercluster reports the final chunk before recalculating cluster bounds.
        // Defer focus so zoomToShowLayer never observes that incomplete state.
        focusTimer = window.setTimeout(() => {
          focusTimer = null;
          if (
            destroyed ||
            !map.hasLayer(cluster) ||
            !cluster.hasLayer(focused)
          ) {
            return;
          }
          cluster.zoomToShowLayer(focused, () => {
            if (destroyed || !map.hasLayer(cluster)) return;
            map.setView(focused.getLatLng(), FOCUSED_PHOTO_ZOOM);
            focused.openPopup();
          });
        }, 0);
      },
    });

    const markers = points.map((point) => {
      const label = photoMapMarkerLabel(point);
      const marker = L.marker([point.latitude, point.longitude], {
        alt: label,
        title: label,
        keyboard: true,
        icon: createPhotoMarkerIcon(),
      });
      marker.bindPopup(() => createPhotoPopup(point), {
        maxWidth: 280,
        minWidth: 180,
      });
      removeMarkerLabels.push(labelMarker(marker, label));
      markersById.set(point.id, marker);
      return marker;
    });

    cluster.addLayers(markers);
    cluster.addTo(map);
    const focusedPoint =
      focusPhotoId === null
        ? undefined
        : points.find((point) => point.id === focusPhotoId);
    if (focusedPoint) {
      map.setView(
        [focusedPoint.latitude, focusedPoint.longitude],
        FOCUSED_PHOTO_ZOOM,
      );
    } else if (points.length === 1) {
      map.setView([points[0].latitude, points[0].longitude], PHOTO_MAP_ZOOM);
    } else {
      map.fitBounds(
        L.latLngBounds(points.map((point) => [point.latitude, point.longitude])),
        { padding: [24, 24], maxZoom: ARCHIVE_BOUNDS_MAX_ZOOM },
      );
    }
    const stopObserving = observeMapSize(map, container);

    return () => {
      destroyed = true;
      if (focusTimer !== null) {
        window.clearTimeout(focusTimer);
      }
      stopObserving();
      removeMarkerLabels.forEach((removeLabel) => removeLabel());
      markers.forEach((marker) => marker.off());
      cluster.clearLayers();
      cluster.off();
      cluster.remove();
      destroyLeafletMap(map);
    };
  }, [focusPhotoId, points]);

  return (
    <div
      role="region"
      aria-label={`Interactive archive map showing ${points.length} geotagged ${points.length === 1 ? "photo" : "photos"}`}
      className={`${styles.frame} ${styles.archiveFrame}`}
    >
      <div ref={containerRef} className={styles.canvas} />
    </div>
  );
}
