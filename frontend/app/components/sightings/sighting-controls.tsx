"use client";

import { useCallback, useId, useRef, useState } from "react";
import { useSightingResource } from "../../hooks/use-sighting-resource";
import { getSightingTaxa, SightingTaxon } from "../../lib/api";
import { taxonLabel } from "../../lib/sightings";

export const buttonStyle = "inline-flex min-h-11 items-center justify-center rounded-md border border-stone-300 bg-white px-3 text-sm font-semibold disabled:opacity-50";
export const primaryStyle = "inline-flex min-h-11 items-center justify-center rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white disabled:opacity-50";
export const inputStyle = "mt-1 min-h-11 w-full min-w-0 rounded-md border border-stone-300 bg-white px-3 text-stone-950";

export function SightingError({ message, retry }: { message: string; retry?: () => void }) {
  return <div role="alert" className="my-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
    <p className="break-words">{message}</p>
    {retry && <button type="button" className="mt-2 min-h-11 underline" onClick={retry}>Retry</button>}
  </div>;
}

export function SightingPagination({ page, totalPages, onPage, label, disabled = false }: {
  page: number; totalPages: number; onPage: (page: number) => void; label: string; disabled?: boolean;
}) {
  if (totalPages <= 1) return null;
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center gap-3 text-sm">
    <button type="button" className={buttonStyle} onClick={() => onPage(page - 1)} disabled={disabled || page <= 1}>Previous</button>
    <span aria-live="polite">Page {page} of {totalPages}</span>
    <button type="button" className={buttonStyle} onClick={() => onPage(page + 1)} disabled={disabled || page >= totalPages}>Next</button>
  </nav>;
}

export function LocalSpeciesPicker({ value, onChange, emptyLabel = "Unidentified", disabled = false }: {
  value: SightingTaxon | null; onChange: (value: SightingTaxon | null) => void; emptyLabel?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const pickerButton = useRef<HTMLButtonElement>(null);
  return <fieldset disabled={disabled} className="min-w-0 space-y-2">
    <legend className="text-sm font-semibold">Verified species</legend>
    <p className="break-words text-sm">{value ? taxonLabel(value) : emptyLabel}</p>
    <div className="flex flex-wrap gap-2">
      <button ref={pickerButton} type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} className={buttonStyle} onClick={() => setOpen(!open)}>
        {open ? "Close species picker" : "Choose species"}
      </button>
      {value && <button type="button" className={buttonStyle} onClick={() => {
        onChange(null); pickerButton.current?.focus();
      }}>Clear species</button>}
    </div>
    {open && <LocalSpeciesResults id={panelId} onSelect={(taxon) => {
      onChange(taxon); setOpen(false); pickerButton.current?.focus();
    }} />}
  </fieldset>;
}

function LocalSpeciesResults({ id, onSelect }: { id: string; onSelect: (value: SightingTaxon) => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const load = useCallback((signal: AbortSignal) => getSightingTaxa(search, page, signal), [search, page]);
  const { data, error, retry } = useSightingResource(load);
  return <div id={id} className="rounded-md border border-stone-200 bg-stone-50 p-3">
    <label className="block text-sm">Search local species
      <input className={inputStyle} value={search} maxLength={200} onKeyDown={(event) => {
        if (event.key === "Enter") event.preventDefault();
      }} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
    </label>
    {error ? <SightingError message={error} retry={retry} /> : !data ? <p role="status" className="mt-2 text-sm">Loading species…</p> : <>
      {data.items.length ? <ul className="mt-2 max-h-44 space-y-1 overflow-auto">
        {data.items.map((taxon) => <li key={taxon.id}>
          <button type="button" className={`${buttonStyle} w-full flex-wrap justify-start gap-1 text-left`} onClick={() => onSelect(taxon)}>
            <span>{taxonLabel(taxon)}</span><span className="font-normal italic text-stone-600">{taxon.scientific_name}</span>
          </button>
        </li>)}
      </ul> : <p className="mt-2 text-sm">No matching species in your local taxonomy.</p>}
      {(page > 1 || data.has_more) && <nav aria-label="Species pages" className="mt-2 flex gap-2">
        <button type="button" className={buttonStyle} disabled={page === 1} onClick={() => setPage(page - 1)}>Previous species</button>
        <button type="button" className={buttonStyle} disabled={!data.has_more} onClick={() => setPage(page + 1)}>More species</button>
      </nav>}
    </>}
  </div>;
}
