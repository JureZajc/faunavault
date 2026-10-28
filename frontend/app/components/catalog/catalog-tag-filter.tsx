"use client";

import { useState } from "react";
import { useCatalogTags } from "../../hooks/use-catalog-tags";

export default function CatalogTagFilter({ tags = [], untagged = false, onChange }: {
  tags?: string[]; untagged?: boolean; onChange: (tags: string[], untagged?: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [enabled, setEnabled] = useState(false);
  const options = useCatalogTags(enabled);
  const matches = (options.data?.tags ?? []).filter((tag) => !tags.includes(tag.name) && tag.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <fieldset className="mt-4 min-w-0 border-t border-stone-100 pt-4">
    <legend className="text-sm font-semibold text-stone-700">Exact tags</legend>
    <p id="tag-filter-help" className="text-xs text-stone-600">Case-sensitive. All selected tags must match (AND). Separate from text search.</p>
    {tags.length >= 20 && <p className="mt-1 text-xs text-stone-600">Maximum 20 tags selected. Remove a tag to choose another.</p>}
    <div className="mt-2 flex flex-wrap items-end gap-3">
      <label className="min-w-0 text-sm">Search tag options<input type="search" value={search} onFocus={() => setEnabled(true)} onChange={(event) => { setEnabled(true); setSearch(event.target.value); }} aria-describedby="tag-filter-help" className="mt-1 block min-h-11 w-full rounded-md border border-stone-300 px-3" /></label>
      <label className="min-w-0 text-sm">Add exact tag<select value="" onFocus={() => setEnabled(true)} disabled={untagged || tags.length >= 20} onChange={(event) => { if (event.target.value) onChange([...tags, event.target.value]); }} className="mt-1 block min-h-11 max-w-full rounded-md border border-stone-300 px-3"><option value="">{options.loading ? "Loading tags…" : "Select a tag"}</option>{matches.map((tag) => <option key={tag.name} value={tag.name}>{tag.name} ({tag.count})</option>)}</select></label>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={untagged} onChange={(event) => onChange([], event.target.checked)} className="h-5 w-5" />Photos without tags</label>
    </div>
    {options.error ? <p role="alert" className="text-sm text-red-700">{options.error} <button type="button" onClick={options.retry} className="min-h-11 underline">Retry tags</button></p> : enabled && !options.loading && options.data && !matches.length ? <p className="mt-2 text-sm">No more matching tags.</p> : null}
    <div aria-label="Active tag filters" className="mt-2 flex flex-wrap gap-2">{tags.map((tag) => <button key={tag} type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((value) => value !== tag))} className="min-h-11 max-w-full break-words rounded-full bg-emerald-100 px-4 text-sm text-emerald-950">{tag} ×</button>)}{untagged && <span className="flex min-h-11 items-center rounded-full bg-emerald-100 px-4 text-sm">Without tags</span>}{(tags.length > 0 || untagged) && <button type="button" onClick={() => onChange([])} className="min-h-11 px-3 text-sm font-semibold underline">Clear tag filters</button>}</div>
  </fieldset>;
}
