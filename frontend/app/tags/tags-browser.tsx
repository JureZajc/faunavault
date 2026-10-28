"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import { notifyTagsChanged, useCatalogTags } from "../hooks/use-catalog-tags";
import { tagListHref } from "../lib/catalog-query";
import { TagOperationRequest } from "../lib/api";
import TagOperationDialog from "./tag-operation-dialog";

export default function TagsBrowser() {
  const { data, loading, error, retry } = useCatalogTags();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [management, setManagement] = useState<TagOperationRequest | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tags = (data?.tags ?? []).filter((tag) => tag.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) =>
    (sort === "count" ? b.count - a.count : 0) || a.name.localeCompare(b.name) || (a.name < b.name ? -1 : 1));
  return <main className="min-h-screen min-w-0 bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <ArchiveNavigation active="tags" />
      <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h1 ref={headingRef} tabIndex={-1} className="text-3xl font-semibold">Tag Explorer</h1>
        <p className="mt-2 text-sm text-stone-600">Explore tags on active photos. Open a tag in List for exact, case-sensitive filtering. Multiple selected tags must all match.</p>
        <p className="mt-2 text-sm text-stone-600">Rename, merge or delete tags across the entire archive, including Trash. Preview every change before confirming.</p>
        {data && !error && <p className="mt-4 text-sm">{data.total_tags} distinct tags · <Link className="inline-flex min-h-11 items-center text-emerald-800 underline" href={tagListHref()}>{data.untagged_count} photos without tags</Link></p>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">Search tags<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-stone-300 px-3" /></label>
          <label className="text-sm font-medium">Sort tags<select value={sort} onChange={(event) => setSort(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-stone-300 px-3"><option value="name">Alphabetical</option><option value="count">Most used</option></select></label>
        </div>
      </header>
      {success && <p role="status" className="mt-4 break-words rounded-lg border border-emerald-300 bg-emerald-50 p-4">{success}</p>}
      <section aria-label="Tags" aria-busy={loading} className="mt-5">
        {loading ? <p role="status">Loading tags…</p> : error ? <div role="alert"><p>{error}</p><button type="button" onClick={retry} className="min-h-11 px-3 font-semibold underline">Retry tags</button></div> : tags.length ? <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{tags.map((tag) => <li key={tag.name} className="min-w-0 rounded-lg border border-stone-200 bg-white">
          <Link aria-label={`${tag.name} ${tag.count} ${tag.count === 1 ? "photo" : "photos"}`} href={tagListHref(tag.name)} className="flex min-h-11 items-center justify-between gap-3 rounded-lg p-4 text-emerald-900 hover:bg-emerald-50"><span className="min-w-0 break-words font-semibold">{tag.name}</span><span className="shrink-0 text-sm text-stone-600">{tag.count} {tag.count === 1 ? "photo" : "photos"}</span></Link>
          <div className="flex flex-wrap gap-1 border-t border-stone-100 px-2">{(["rename", "merge", "delete"] as const).map((operation) => <button key={operation} type="button" aria-label={`${operation === "rename" ? "Rename" : operation === "merge" ? "Merge" : "Delete"} tag ${tag.name}`} onClick={() => { setSuccess(null); setManagement({ operation, source: tag.name }); }} className={`min-h-11 rounded px-3 text-sm font-semibold hover:bg-stone-100 ${operation === "delete" ? "text-red-800" : "text-emerald-900"}`}>{operation === "rename" ? "Rename" : operation === "merge" ? "Merge" : "Delete"}</button>)}</div>
        </li>)}</ul> : <p role="status">{search ? "No tags match your search." : "No tags yet. Add tags to photos in List or on a photo’s edit form."}</p>}
      </section>
    </div>
    {management && <TagOperationDialog operation={management.operation} source={management.source} tags={(data?.tags ?? []).map((tag) => tag.name)} fallbackFocusRef={headingRef} onClose={() => setManagement(null)} onSuccess={(result) => {
      setSuccess(`${result.operation === "delete" ? "Deleted" : result.operation === "merge" ? "Merged" : "Renamed"} tag “${result.source}”${result.destination ? ` → “${result.destination}”` : ""}. Updated ${result.updated_photos} Photos (${result.active_photos} active, ${result.trashed_photos} in Trash).`);
      setManagement(null); notifyTagsChanged();
    }} />}
  </main>;
}
