"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { AreaBounds, areaSummary, BOUND_KEYS, BoundsQuery, boundsError, hasArea, parseCoordinate } from "../../lib/geographic-bounds";

export default function MapAreaControls({ value, selecting, onSelectingChange, onChange, listHref, ready, count, error }: {
  value: BoundsQuery; selecting: boolean; onSelectingChange: (value: boolean) => void;
  onChange: (area?: AreaBounds) => void; listHref: string; ready: boolean; count: number; error: string | null;
}) {
  const [draft, setDraft] = useState(() => BOUND_KEYS.map((key) => value[key] === undefined ? "" : String(value[key])));
  const [inputError, setInputError] = useState<string | null>(null);
  const incoming = BOUND_KEYS.map((key) => value[key] === undefined ? "" : String(value[key]));
  const incomingKey = incoming.join("|");
  const [previousKey, setPreviousKey] = useState(incomingKey);
  if (incomingKey !== previousKey) {
    setPreviousKey(incomingKey); setDraft(incoming); setInputError(null);
  }
  const firstInput = useRef<HTMLInputElement>(null);
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
    <form noValidate className="mt-4" onSubmit={(event) => {
      event.preventDefault();
      const area = Object.fromEntries(BOUND_KEYS.map((key, index) => [key, parseCoordinate(draft[index])])) as AreaBounds;
      const nextError = boundsError(area);
      setInputError(nextError);
      if (nextError) { firstInput.current?.focus(); return; }
      onSelectingChange(false); onChange(area); selectButton.current?.focus();
    }}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {BOUND_KEYS.map((key, index) => <label key={key} className="text-sm font-medium text-stone-700">
          {["South latitude", "North latitude", "West longitude", "East longitude"][index]}
          <input ref={index === 0 ? firstInput : undefined} type="text" inputMode="decimal" value={draft[index]} aria-invalid={Boolean(inputError || error)} aria-describedby={inputError || error ? "area-error" : "area-instructions"}
            onChange={(event) => { setDraft(draft.map((value, position) => position === index ? event.target.value : value)); setInputError(null); }}
            className="mt-2 min-h-11 w-full rounded-md border border-stone-300 px-3" />
        </label>)}
      </div>
      <button type="submit" className={`${buttonClass} mt-3`}>Apply coordinates</button>
      {inputError || error ? <p id="area-error" role="alert" className="mt-3 text-sm text-red-700">{inputError || error}</p> : null}
    </form>
    <p aria-label="Selected geographic area" className="mt-3 text-sm text-stone-600">{areaSummary(value)}</p>
    {selected && !boundsError(value) && <p aria-live="polite" className="mt-2 text-sm font-semibold text-stone-700"><span>{ready ? `${count} mapped ${count === 1 ? "photo matches" : "photos match"} this area` : "Selected area results are unavailable until location loading succeeds."}</span>. Only Photos with complete valid GPS can match an area.</p>}
  </section>;
}
