"use client";

import { useState } from "react";
import { EquipmentQuery } from "../../lib/api";
import { equipmentQuery, hasEquipmentFilters } from "../../lib/catalog-query";
import { useCatalogGear } from "../../hooks/use-catalog-gear";

export default function CatalogGearFilter({ value, onChange }: { value: EquipmentQuery; onChange: (value: EquipmentQuery) => void }) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [enabled, setEnabled] = useState(false);
  const options = useCatalogGear(search, "name", page, enabled);
  const current = equipmentQuery(value);
  const cameras = options.data?.cameras ?? [];
  const fields = [
    { key: "camera_make", label: "Camera manufacturer", values: cameras.map((camera) => camera.camera_make ?? "") },
    { key: "camera_model", label: "Camera model", values: cameras.map((camera) => camera.camera_model ?? "") },
    { key: "lens_model", label: "Lens model", values: (options.data?.lenses ?? []).map((lens) => lens.lens_model) },
  ] as const;
  return <fieldset onFocus={() => setEnabled(true)} className="mt-4 min-w-0 border-t border-stone-100 pt-4">
    <legend className="text-sm font-semibold text-stone-700">Exact equipment</legend>
    <p className="text-xs text-stone-600">Case-sensitive, trimmed EXIF values. Manufacturer, model and lens combine with AND. Search options to find equipment in large archives.</p>
    <div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="min-w-0 text-sm">Search equipment options<input type="search" maxLength={200} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className="mt-1 block min-h-11 w-full rounded-md border border-stone-300 px-3" /></label>
      {fields.map(({ key, label, values }) => <label key={key} className="min-w-0 text-sm">{label}<select value={current[key] === undefined ? "all" : JSON.stringify(current[key])} onChange={(event) => onChange({ ...current, [key]: event.target.value === "all" ? undefined : JSON.parse(event.target.value), ...(key === "lens_model" ? { unknown_lens: undefined } : { unknown_camera: undefined }) })} className="mt-1 block min-h-11 w-full min-w-0 rounded-md border border-stone-300 px-3"><option value="all">All {label.toLowerCase()}s</option>{Array.from(new Set([...values, ...(current[key] === undefined ? [] : [current[key]])])).sort().map((item) => <option key={item} value={JSON.stringify(item)}>{item || "Missing metadata"}</option>)}</select></label>)}
    </div>
    <div className="mt-2 flex flex-wrap gap-3">
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(current.unknown_camera)} onChange={(event) => onChange({ ...current, camera_make: undefined, camera_model: undefined, unknown_camera: event.target.checked || undefined })} className="h-5 w-5" />Photos without camera information</label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(current.unknown_lens)} onChange={(event) => onChange({ ...current, lens_model: undefined, unknown_lens: event.target.checked || undefined })} className="h-5 w-5" />Photos without lens information</label>
    </div>
    {options.loading && <p role="status" className="text-sm">Loading equipment options…</p>}
    {options.error ? <p role="alert" className="text-sm text-red-700">{options.error} <button type="button" onClick={options.retry} className="min-h-11 underline">Retry equipment options</button></p> : options.data && Math.max(options.data.camera_total, options.data.lens_total) > options.data.page_size && <div className="flex items-center gap-3 text-sm"><button type="button" disabled={page === 1 || options.loading} onClick={() => setPage(page - 1)} className="min-h-11 underline disabled:opacity-50">Previous options</button><span>Options page {page}</span><button type="button" disabled={options.loading || page * options.data.page_size >= Math.max(options.data.camera_total, options.data.lens_total)} onClick={() => setPage(page + 1)} className="min-h-11 underline disabled:opacity-50">Next options</button></div>}
    <div aria-label="Active equipment filters" className="mt-2 flex flex-wrap gap-2">
      {fields.map(({ key, label }) => current[key] !== undefined && <button type="button" key={key} aria-label={`Remove ${label.toLowerCase()} filter`} onClick={() => onChange({ ...current, [key]: undefined })} className="min-h-11 max-w-full break-words rounded-full bg-emerald-100 px-4 text-sm">{label}: {current[key] || "Missing metadata"} ×</button>)}
      {(["unknown_camera", "unknown_lens"] as const).map((key) => current[key] && <button type="button" key={key} onClick={() => onChange({ ...current, [key]: undefined })} className="min-h-11 rounded-full bg-emerald-100 px-4 text-sm">Remove {key === "unknown_camera" ? "unknown camera" : "unknown lens"} filter</button>)}
      {hasEquipmentFilters(current) && <button type="button" onClick={() => onChange({})} className="min-h-11 px-3 text-sm font-semibold underline">Clear equipment filters</button>}
    </div>
  </fieldset>;
}
