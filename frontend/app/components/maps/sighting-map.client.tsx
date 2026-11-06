"use client";

import L from "leaflet";
import "leaflet.markercluster";
import { useEffect, useRef } from "react";
import { imageUrl, SightingMapPoint } from "../../lib/api";
import { AreaBounds, boundsError, boundsFromCorners, displayAreaBounds } from "../../lib/geographic-bounds";
import { ARCHIVE_BOUNDS_MAX_ZOOM, FOCUSED_PHOTO_ZOOM, PHOTO_MAP_ZOOM } from "../../lib/map-config";
import { formatCameraLocalDate } from "../../lib/photo-metadata";
import { buttonStyle } from "../sightings/sighting-controls";
import { AREA_STYLE } from "./leaflet-area-selection";
import { detachClusterMoveListeners } from "./leaflet-cluster";
import { createLeafletMap, createPhotoMarkerIcon, destroyLeafletMap, labelMarker, observeMapSize } from "./leaflet-map-core";
import styles from "./photo-map.module.css";

const MAX_MERCATOR_LATITUDE = 85.0511287798;

export type SightingMapProps = {
  points: SightingMapPoint[];
  focusId?: number;
  area?: AreaBounds;
  onAreaSelect: (area: AreaBounds) => void;
};

function sightingTitle(point: SightingMapPoint) {
  return point.subject_label || point.common_name?.trim() || point.scientific_name || "Unidentified sighting";
}

export function createSightingPopup(point: SightingMapPoint) {
  const content = document.createElement("div");
  content.className = styles.popup;
  if (point.thumbnail_filename) {
    const image = document.createElement("img");
    image.className = styles.popupImage;
    image.src = imageUrl("thumbs", point.thumbnail_filename);
    image.alt = "Photo linked to this sighting";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove(), { once: true });
    content.append(image);
  }

  const title = document.createElement("p");
  title.className = styles.popupTitle;
  title.textContent = sightingTitle(point);
  const observed = document.createElement("p");
  observed.className = styles.popupMeta;
  const date = document.createElement("time");
  date.dateTime = point.observed_at;
  date.textContent = formatCameraLocalDate(point.observed_at);
  observed.append("Observed ", date);
  content.append(title, observed);

  if (point.location_label) {
    const location = document.createElement("p");
    location.className = styles.popupMeta;
    location.textContent = point.location_label;
    content.append(location);
  }
  const link = document.createElement("a");
  link.className = styles.popupLink;
  link.href = `/sightings/${point.id}`;
  link.textContent = "Open Sighting";
  content.append(link);
  return content;
}

function markerWest(points: SightingMapPoint[], area?: AreaBounds) {
  if (area) return area.bbox_west;
  const longitudes = points.map((point) => point.longitude).sort((a, b) => a - b);
  // Cut the globe at the largest gap to fit nearby points across the dateline.
  let west = longitudes[0];
  let largestGap = west + 360 - longitudes[longitudes.length - 1];
  for (let i = 1; i < longitudes.length; i++) {
    const gap = longitudes[i] - longitudes[i - 1];
    if (gap > largestGap) {
      largestGap = gap;
      west = longitudes[i];
    }
  }
  return west;
}

function displayLatitude(latitude: number) {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export default function SightingMapClient({ points, focusId, area, onAreaSelect }: SightingMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const disposeLayers = useRef<(() => void) | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = createLeafletMap(container, { scrollWheelZoom: false, zoomAnimation: false });
    mapRef.current = map;
    const stopObserving = observeMapSize(map, container);
    return () => {
      disposeLayers.current?.();
      mapRef.current = null;
      stopObserving();
      destroyLeafletMap(map);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || (!points.length && !area)) return;
    const west = markerWest(points, area);
    const cluster = L.markerClusterGroup({
      animate: false,
      chunkedLoading: false,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
    });
    const markerIcon = createPhotoMarkerIcon();
    const markers = points.map((point) => {
      const label = `Open map preview for ${sightingTitle(point)}`;
      const longitude = point.longitude < west ? point.longitude + 360 : point.longitude;
      const marker = L.marker([displayLatitude(point.latitude), longitude], {
        alt: label, title: label, keyboard: true, icon: markerIcon,
      }).bindPopup(() => createSightingPopup(point), { maxWidth: 280 });
      return { marker, removeLabel: labelMarker(marker, label) };
    });
    const focused = markers[points.findIndex((point) => point.id === focusId)]?.marker;
    const options = { padding: [24, 24] as L.PointTuple, maxZoom: ARCHIVE_BOUNDS_MAX_ZOOM, animate: false };
    let rectangle: L.Rectangle | undefined;
    if (area) {
      const bounds = L.latLngBounds(displayAreaBounds(area).map(([lat, lng]) => [displayLatitude(lat), lng] as L.LatLngTuple));
      rectangle = L.rectangle(bounds, AREA_STYLE).addTo(map);
      if (!focused) map.fitBounds(bounds, options);
    }
    if (focused) {
      map.setView(focused.getLatLng(), FOCUSED_PHOTO_ZOOM, { animate: false });
    } else if (!area && markers.length === 1) {
      map.setView(markers[0].marker.getLatLng(), PHOTO_MAP_ZOOM, { animate: false });
    } else if (!area) {
      map.fitBounds(L.latLngBounds(markers.map(({ marker }) => marker.getLatLng())), options);
    }

    cluster.addTo(map);
    let disposed = false;
    let frame: number | undefined;
    let offset = 0;
    const addBatch = () => {
      if (disposed) return;
      frame = undefined;
      const end = Math.min(offset + 500, markers.length);
      cluster.addLayers(markers.slice(offset, end).map(({ marker }) => marker));
      offset = end;
      if (end < markers.length) {
        frame = window.requestAnimationFrame(addBatch);
      } else if (focused) {
        cluster.zoomToShowLayer(focused, () => {
          if (!disposed) focused.openPopup();
        });
      }
    };
    addBatch();

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      detachClusterMoveListeners(map, cluster);
      for (const { marker, removeLabel } of markers) {
        removeLabel();
        marker.unbindPopup();
        marker.off();
      }
      cluster.off();
      cluster.clearLayers();
      cluster.remove();
      rectangle?.remove();
    };
    disposeLayers.current = cleanup;
    return () => {
      cleanup();
      if (disposeLayers.current === cleanup) disposeLayers.current = null;
    };
  }, [area, focusId, points]);

  return <div className="space-y-2">
    <div role="region" aria-label="Interactive Sightings Map" className={`${styles.frame} ${styles.archiveFrame}`}>
      <div ref={containerRef} className={styles.canvas} />
    </div>
    <button type="button" className={buttonStyle} onClick={() => {
      const bounds = mapRef.current?.getBounds();
      if (!bounds) return;
      const southwest = bounds.getSouthWest();
      const northeast = bounds.getNorthEast();
      const visibleArea = boundsFromCorners(
        { lat: southwest.lat <= -MAX_MERCATOR_LATITUDE ? -90 : southwest.lat, lng: southwest.lng },
        { lat: northeast.lat >= MAX_MERCATOR_LATITUDE ? 90 : northeast.lat, lng: northeast.lng },
      );
      if (!boundsError(visibleArea)) onAreaSelect(visibleArea);
    }}>Search this map area</button>
  </div>;
}
