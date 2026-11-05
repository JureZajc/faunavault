"use client";

import { useRef } from "react";
import Link from "next/link";
import AreaCoordinateForm from "../catalog/area-coordinate-form";
import { AreaBounds, areaSummary, BoundsQuery, boundsError, hasArea } from "../../lib/geographic-bounds";

export default function MapAreaControls({ value, selecting, onSelectingChange, onChange, listHref, ready, count, error }: {
  value: BoundsQuery; selecting: boolean; onSelectingChange: (value: boolean) => void;
  onChange: (area?: AreaBounds) => void; listHref: string; ready: boolean; count: number; error: string | null;
}) {
  const selectButton = useRef<HTMLButtonElement>(null);
  const selected = hasArea(value);
  const buttonClass = "min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50";
  return <section aria-label="Geographic area selection" className="mt-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
    <h2 className="text-lg font-semibold">Select geographic area</h2>
    <p id="area-instructions" className="mt-2 text-sm text-stone-600">Select area, then drag a rectangle or tap two opposite corners. Use the coordinate fields for keyboard selection. West greater than East selects across the antimeridian.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button ref={selectButton} type="button" aria-pressed={selecting} aria-describedby="area-instructions" className={buttonClass} onClick={() => onSelectingChange(!selecting)}>{selecting ? "Cancel selection" : selected ? "Select another area" : "Select area"}</button>
      {selected && <button type="button" className={buttonClass} onClick={() => { onSelectingChange(false); onChange(); selectButton.current?.focus(); }}>Clear area</button>}
      {selected && !boundsError(value) && <Link href={listHref} className={buttonClass}>View selected area in List</Link>}
    </div>
    {selecting && <p role="status" className="mt-3 text-sm font-semibold text-amber-900">Selection mode: drag, or tap the first corner and then the opposite corner. Press Escape or Cancel selection to cancel.</p>}
    <AreaCoordinateForm value={value} instructionsId="area-instructions" error={error}
      onApply={(area) => { onSelectingChange(false); onChange(area); selectButton.current?.focus(); }} />
    <p aria-label="Selected geographic area" className="mt-3 text-sm text-stone-600">{areaSummary(value)}</p>
    {selected && !boundsError(value) && <p aria-live="polite" className="mt-2 text-sm font-semibold text-stone-700"><span>{ready ? `${count} mapped ${count === 1 ? "photo matches" : "photos match"} this area` : "Selected area results are unavailable until location loading succeeds."}</span>. Only Photos with complete valid GPS can match an area.</p>}
  </section>;
}
