"use client";

import { useId, useRef, useState } from "react";
import { AreaBounds, BOUND_KEYS, BoundsQuery, boundsError, parseCoordinate } from "../../lib/geographic-bounds";

const labels = ["South latitude", "North latitude", "West longitude", "East longitude"];

export default function AreaCoordinateForm({ value, onApply, instructionsId, error }: {
  value: BoundsQuery;
  onApply: (area: AreaBounds) => void;
  instructionsId: string;
  error?: string | null;
}) {
  const incoming = BOUND_KEYS.map((key) => value[key] === undefined ? "" : String(value[key]));
  const incomingKey = incoming.join("|");
  const [previousKey, setPreviousKey] = useState(incomingKey);
  const [draft, setDraft] = useState(incoming);
  const [inputError, setInputError] = useState<string | null>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  if (incomingKey !== previousKey) {
    setPreviousKey(incomingKey);
    setDraft(incoming);
    setInputError(null);
  }
  const message = inputError || error;

  return <form noValidate className="mt-4" onSubmit={(event) => {
    event.preventDefault();
    const area = Object.fromEntries(BOUND_KEYS.map((key, index) => [key, parseCoordinate(draft[index])])) as AreaBounds;
    const nextError = boundsError(area);
    setInputError(nextError);
    if (nextError) { firstInput.current?.focus(); return; }
    onApply(area);
  }}>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {BOUND_KEYS.map((key, index) => <label key={key} className="text-sm font-medium text-stone-700">
        {labels[index]}
        <input ref={index === 0 ? firstInput : undefined} type="text" inputMode="decimal" value={draft[index]} aria-invalid={Boolean(message)} aria-describedby={message ? errorId : instructionsId}
          onChange={(event) => { setDraft(draft.map((value, position) => position === index ? event.target.value : value)); setInputError(null); }}
          className="mt-2 min-h-11 w-full rounded-md border border-stone-300 px-3" />
      </label>)}
    </div>
    <button type="submit" className="mt-3 min-h-11 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">Apply coordinates</button>
    {message && <p id={errorId} role="alert" className="mt-3 text-sm text-red-700">{message}</p>}
  </form>;
}
