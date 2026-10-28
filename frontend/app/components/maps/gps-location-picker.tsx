"use client";

import dynamic from "next/dynamic";
import { Component, ReactNode, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { parseLocationFields } from "../../lib/photo-metadata";
import type { GpsCoordinates } from "./gps-picker-map.client";
import styles from "./photo-map.module.css";

const GpsPickerMap = dynamic(() => import("./gps-picker-map.client"), {
  ssr: false,
  loading: () => <div role="status" className={`${styles.loading} ${styles.pickerFrame}`}>Loading location picker map…</div>,
});

const mapError = "Map unavailable. You can still enter latitude and longitude below.";

class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">{mapError}</p> : this.props.children;
  }
}

type Props = {
  latitude: string;
  longitude: string;
  disabled?: boolean;
  onChange: (coordinates: GpsCoordinates) => void;
};

export default function GpsLocationPicker(props: Props) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" disabled={props.disabled} onClick={() => setOpen(true)} className="min-h-11 rounded-md border border-emerald-200 bg-emerald-50 px-3 text-sm font-semibold text-emerald-900 disabled:opacity-50">Choose on map</button>
    {open ? <PickerDialog {...props} onClose={() => setOpen(false)} /> : null}
  </>;
}

function PickerDialog({ latitude, longitude, onChange, onClose }: Props & { onClose: () => void }) {
  const [lat, setLat] = useState(latitude);
  const [lon, setLon] = useState(longitude);
  const [unavailable, setUnavailable] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef, initialFocusRef: inputRef, onClose });
  let selected: GpsCoordinates | null = null;
  let error: string | null = null;
  try {
    const parsed = parseLocationFields(lat, lon);
    if (parsed.latitude !== null && parsed.longitude !== null) selected = { latitude: parsed.latitude, longitude: parsed.longitude };
  } catch (failure) {
    error = failure instanceof Error ? failure.message : "Invalid coordinates.";
  }
  function select(coordinates: GpsCoordinates) {
    setLat(String(coordinates.latitude));
    setLon(String(coordinates.longitude));
  }
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-950/50 p-3">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-instructions`} tabIndex={-1}
        onChange={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Portals still bubble React events to the enclosing metadata form/dialog.
          event.stopPropagation();
          handleKeyDown(event);
          if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
        }}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl min-w-0 overflow-y-auto overscroll-contain rounded-lg bg-white p-4 shadow-xl sm:p-6">
        <h2 id={`${id}-title`} className="text-xl font-semibold">Choose GPS location</h2>
        <p id={`${id}-instructions`} className="my-3 text-sm text-stone-600">Click or tap the map to select a location. Drag the marker to refine it, or enter both coordinates below using the keyboard. Zoom and pan to explore.</p>
        <MapBoundary><GpsPickerMap value={selected} onChange={select} onUnavailable={setUnavailable} /></MapBoundary>
        {unavailable ? <p role="alert" className="mt-2 text-sm text-amber-800">{mapError}</p> : null}
        <p className="mt-2 text-xs text-stone-500">Loading map tiles contacts the configured external tile provider. Manual entry works offline. No device location is requested.</p>
        <div className="my-3 grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium" htmlFor={`${id}-lat`}>Latitude
            <input ref={inputRef} id={`${id}-lat`} type="text" inputMode="decimal" value={lat} onChange={(event) => setLat(event.target.value)} aria-invalid={!!error} aria-describedby={`${id}-selection`} placeholder="-90 to 90" className="mt-1 min-h-11 w-full min-w-0 rounded-md border border-stone-300 px-3" />
          </label>
          <label className="text-sm font-medium" htmlFor={`${id}-lon`}>Longitude
            <input id={`${id}-lon`} type="text" inputMode="decimal" value={lon} onChange={(event) => setLon(event.target.value)} aria-invalid={!!error} aria-describedby={`${id}-selection`} placeholder="-180 to 180" className="mt-1 min-h-11 w-full min-w-0 rounded-md border border-stone-300 px-3" />
          </label>
        </div>
        <p id={`${id}-selection`} role="status" aria-live="polite" className="break-words text-sm text-stone-700">{error ?? (selected ? `Selected: ${selected.latitude}, ${selected.longitude}` : "No location selected. Choose a point or enter both coordinates.")}</p>
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button type="button" onClick={onClose} className="min-h-11 rounded-md border border-stone-300 px-4 font-semibold">Cancel</button>
          <button type="button" disabled={!selected} onClick={() => { if (selected) { onChange(selected); onClose(); } }} className="min-h-11 rounded-md bg-emerald-800 px-4 font-semibold text-white disabled:opacity-50">Use this location</button>
        </div>
      </div>
    </div>, document.body,
  );
}
