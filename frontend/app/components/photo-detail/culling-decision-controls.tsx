"use client";

import { PhotoCullingState } from "../../lib/api";

export function cullingLabel(state: PhotoCullingState | null) {
  return state === "pick" ? "Picked" : state === "reject" ? "Rejected" : "Undecided";
}

export default function CullingDecisionControls({ state, disabled, shortcuts = false, onChange }: {
  state: PhotoCullingState | null;
  disabled: boolean;
  shortcuts?: boolean;
  onChange: (state: PhotoCullingState | null) => void;
}) {
  return <section aria-label="Culling decision" className="mt-4">
    <p className="text-sm font-medium text-stone-700">Culling: <span>{cullingLabel(state)}</span></p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" disabled={disabled} aria-pressed={state === "pick"} onClick={() => onChange("pick")} className="min-h-11 rounded-md border border-emerald-700 px-4 text-sm font-semibold text-emerald-900 aria-pressed:bg-emerald-100 disabled:opacity-50">Pick{shortcuts ? " (P)" : ""}</button>
      <button type="button" disabled={disabled} aria-pressed={state === "reject"} onClick={() => onChange("reject")} className="min-h-11 rounded-md border border-red-700 px-4 text-sm font-semibold text-red-900 aria-pressed:bg-red-50 disabled:opacity-50">Reject{shortcuts ? " (X)" : ""}</button>
      <button type="button" disabled={disabled || state == null} onClick={() => onChange(null)} className="min-h-11 rounded-md border border-stone-300 px-3 text-sm font-semibold disabled:opacity-50">Clear decision{shortcuts ? " (U)" : ""}</button>
    </div>
  </section>;
}
