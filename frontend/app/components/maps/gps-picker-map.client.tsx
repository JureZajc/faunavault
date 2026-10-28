"use client";

import L from "leaflet";
import { useEffect, useRef } from "react";
import { PHOTO_MAP_ZOOM } from "../../lib/map-config";
import { createLeafletMap, createPhotoMarkerIcon, destroyLeafletMap, labelMarker, observeMapSize } from "./leaflet-map-core";
import styles from "./photo-map.module.css";

export type GpsCoordinates = { latitude: number; longitude: number };
type Props = {
  value: GpsCoordinates | null;
  onChange: (value: GpsCoordinates) => void;
  onUnavailable: (unavailable: boolean) => void;
};

function coordinatesFromPosition(position: L.LatLng): GpsCoordinates | null {
  // Leaflet repeats the world horizontally. Store the equivalent canonical longitude.
  const wrapped = position.wrap();
  if (!Number.isFinite(wrapped.lat) || !Number.isFinite(wrapped.lng)) return null;
  const latitude = Math.max(-90, Math.min(90, wrapped.lat));
  return Number.isFinite(latitude) && Number.isFinite(wrapped.lng)
    ? { latitude, longitude: wrapped.lng } : null;
}

export default function GpsPickerMap({ value, onChange, onUnavailable }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const draggingRef = useRef(false);
  const callbacks = useRef({ onChange, onUnavailable });
  const initialValue = useRef(value);
  useEffect(() => { callbacks.current = { onChange, onUnavailable }; }, [onChange, onUnavailable]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: L.Map | null = null;
    let stopObserving: (() => void) | undefined;
    const tiles: L.TileLayer[] = [];
    const tileError = () => callbacks.current.onUnavailable(true);
    const tileLoad = () => callbacks.current.onUnavailable(false);
    try {
      map = createLeafletMap(container, { scrollWheelZoom: true });
      mapRef.current = map;
      const initial = initialValue.current;
      if (initial) map.setView([initial.latitude, initial.longitude], PHOTO_MAP_ZOOM);
      map.eachLayer((layer) => {
        if (layer instanceof L.TileLayer) {
          tiles.push(layer);
          layer.on("tileerror", tileError);
          layer.on("tileload", tileLoad);
        }
      });
      map.on("click", (event: L.LeafletMouseEvent) => {
        const coordinates = coordinatesFromPosition(event.latlng);
        if (coordinates) callbacks.current.onChange(coordinates);
      });
      stopObserving = observeMapSize(map, container);
    } catch {
      if (map) destroyLeafletMap(map);
      map = null;
      mapRef.current = null;
      callbacks.current.onUnavailable(true);
    }
    return () => {
      stopObserving?.();
      tiles.forEach((layer) => { layer.off("tileerror", tileError); layer.off("tileload", tileLoad); });
      markerRef.current?.off();
      markerRef.current?.remove();
      markerRef.current = null;
      draggingRef.current = false;
      if (map) destroyLeafletMap(map);
      mapRef.current = null;
    };
  }, []);

  const latitude = value?.latitude;
  const longitude = value?.longitude;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (draggingRef.current) return;
    if (latitude === undefined || longitude === undefined) {
      markerRef.current?.off();
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const label = "Selected GPS location; drag to adjust or edit coordinates below";
      const marker = L.marker([latitude, longitude], { draggable: true, keyboard: true, autoPan: true, icon: createPhotoMarkerIcon(), alt: label, title: label });
      labelMarker(marker, label);
      marker.on("dragstart", () => { draggingRef.current = true; });
      marker.on("drag", () => {
        const coordinates = coordinatesFromPosition(marker.getLatLng());
        if (coordinates) callbacks.current.onChange(coordinates);
      });
      marker.on("dragend", () => {
        draggingRef.current = false;
        const coordinates = coordinatesFromPosition(marker.getLatLng());
        if (coordinates) {
          marker.setLatLng([coordinates.latitude, coordinates.longitude]);
          callbacks.current.onChange(coordinates);
        }
      });
      markerRef.current = marker.addTo(map);
    } else markerRef.current.setLatLng([latitude, longitude]);
    map.panTo([latitude, longitude], { animate: false });
  }, [latitude, longitude]);

  return <div role="region" aria-label="GPS location picker map" className={`${styles.frame} ${styles.pickerFrame}`}>
    <div ref={containerRef} className={`${styles.canvas} ${styles.pickerCanvas}`} />
  </div>;
}
