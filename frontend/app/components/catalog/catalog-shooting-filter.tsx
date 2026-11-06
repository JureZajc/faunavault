"use client";

import { useId, useState, type FormEvent } from "react";
import {
  hasShootingRanges,
  SHOOTING_RANGES,
  SHOOTING_RANGE_KEYS,
  validateShootingRanges,
  type ShootingRangeQuery,
} from "../../lib/shooting-settings";

type Props = { value: ShootingRangeQuery; onChange: (value: ShootingRangeQuery) => void };

export default function CatalogShootingFilter({ value, onChange }: Props) {
  const active = hasShootingRanges(value);
  const version = SHOOTING_RANGE_KEYS.map((key) => value[key]).join(",");
  return (
    <details open={active || undefined} className="mt-4 rounded-lg border border-stone-200 px-3">
      <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-stone-800">
        Shooting Settings filters{active ? " · Active" : ""}
      </summary>
      <RangeForm key={version} value={value} onChange={onChange} />
    </details>
  );
}

function RangeForm({ value, onChange }: Props) {
  const [draft, setDraft] = useState(() => Object.fromEntries(
    SHOOTING_RANGE_KEYS.map((key) => [key, value[key] === undefined ? "" : String(value[key])]),
  ));
  const [showError, setShowError] = useState(false);
  const validation = validateShootingRanges(draft);
  const error = showError ? validation.error : undefined;
  const instructionsId = useId();
  const errorId = useId();

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (validation.ranges) onChange(validation.ranges);
    else setShowError(true);
  }

  function clear() {
    setDraft({});
    setShowError(false);
    if (hasShootingRanges(value)) onChange({});
  }

  return (
    <form onSubmit={apply} className="pb-3">
      <p id={instructionsId} className="mb-3 text-sm text-stone-600">
        Enter either limit or both. All ranges include their limits and require the corresponding EXIF setting. For exposure time, enter seconds such as 0.0005 for 1/2000 s.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SHOOTING_RANGES.map(({ field, label }) => (
          <fieldset key={field} className="min-w-0">
            <legend className="text-sm font-semibold text-stone-700">{label}</legend>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {(["min", "max"] as const).map((limit) => {
                const key = `${field}_${limit}` as const;
                const limitLabel = limit === "min" ? "Minimum" : "Maximum";
                const invalid = Boolean(error && validation.invalid === key);
                return (
                  <label key={key} className="min-w-0 text-xs text-stone-600">
                    {limitLabel}
                    <input
                      type="text"
                      aria-label={`${limitLabel} ${label}`}
                      inputMode={field === "iso_speed" ? "numeric" : "decimal"}
                      aria-invalid={invalid || undefined}
                      aria-describedby={invalid ? errorId : instructionsId}
                      value={draft[key] ?? ""}
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      className="mt-1 min-h-11 w-full rounded-md border border-stone-300 bg-stone-50 px-2 text-sm text-stone-950 focus-visible:outline-2 focus-visible:outline-emerald-700"
                    />
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      {error && <p id={errorId} role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className="min-h-11 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white">Apply shooting filters</button>
        {(hasShootingRanges(value) || Object.values(draft).some(Boolean)) && (
          <button type="button" onClick={clear} className="min-h-11 rounded-md border border-stone-300 px-4 text-sm font-semibold text-stone-700">Clear shooting filters</button>
        )}
      </div>
    </form>
  );
}
