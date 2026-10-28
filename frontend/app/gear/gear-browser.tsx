"use client";

import Link from "next/link";
import { useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import { useCatalogGear } from "../hooks/use-catalog-gear";
import { cameraLabel, gearListHref } from "../lib/catalog-query";

export default function GearBrowser() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(1);
  const { data, loading, error, retry } = useCatalogGear(search, sort, page);
  const control = "mt-2 min-h-11 w-full rounded-md border border-stone-300 px-3";
  return <main className="min-h-screen min-w-0 bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <ArchiveNavigation active="gear" />
      <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <h1 className="text-3xl font-semibold">Camera &amp; Lens Explorer</h1>
        <p className="mt-2 text-sm text-stone-600">Explore stored EXIF equipment on active Photos. Links open exact, case-sensitive filters in List. Different criteria must all match.</p>
        <p className="mt-2 text-sm text-stone-600">Metadata is descriptive and may be incomplete. Brands and missing equipment are never inferred; differently spelled models stay separate.</p>
        {data && !error && <div aria-label="Equipment overview" className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <p>{data.active_total} active Photos</p><p>{data.distinct_camera_models} distinct camera models</p><p>{data.distinct_lens_models} distinct lens models</p>
          <Link className="inline-flex min-h-11 items-center text-emerald-800 underline" href={gearListHref({ unknown_camera: true })}>{data.unknown_camera_count} Photos without camera information</Link>
          <Link className="inline-flex min-h-11 items-center text-emerald-800 underline" href={gearListHref({ unknown_lens: true })}>{data.unknown_lens_count} Photos without lens information</Link>
        </div>}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">Search cameras and lenses<input type="search" maxLength={200} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className={control} /></label>
          <label className="text-sm font-medium">Sort equipment<select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }} className={control}><option value="name">Alphabetical</option><option value="count">Most used</option></select></label>
        </div>
      </header>
      {loading ? <p role="status" className="mt-5">Loading equipment…</p> : error ? <div role="alert" className="mt-5"><p>{error}</p><button onClick={retry} className="min-h-11 px-3 underline">Retry equipment</button></div> : data && <>
        {data.active_total === 0 && <p role="status" className="mt-5">No active Photos yet. Import Photos to explore their equipment.</p>}
        <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-2">
          <section aria-label="Cameras" className="min-w-0"><h2 className="mb-3 text-xl font-semibold">Cameras ({data.camera_total})</h2>
            {data.cameras.length ? <ul className="space-y-3">{data.cameras.map((camera) => <li key={JSON.stringify([camera.camera_make, camera.camera_model])} className="rounded-lg border border-stone-200 bg-white">
              <Link aria-label={`${cameraLabel(camera)} ${camera.count} Photos · ${camera.percentage.toFixed(1)}%`} href={gearListHref({ camera_make: camera.camera_make ?? "", camera_model: camera.camera_model ?? "" })} className="flex min-h-11 flex-wrap items-center justify-between gap-3 p-4 text-emerald-900"><span className="min-w-0 break-words font-semibold">{cameraLabel(camera)}</span><span className="text-sm text-stone-600">{camera.count} Photos · {camera.percentage.toFixed(1)}%</span></Link>
            </li>)}</ul> : <p>No cameras{search ? " match your search" : " identified"}.</p>}
          </section>
          <section aria-label="Lenses" className="min-w-0"><h2 className="mb-3 text-xl font-semibold">Lenses ({data.lens_total})</h2>
            {data.lenses.length ? <ul className="space-y-3">{data.lenses.map((lens) => <li key={lens.lens_model} className="rounded-lg border border-stone-200 bg-white"><Link aria-label={`${lens.lens_model} ${lens.count} Photos · ${lens.percentage.toFixed(1)}%`} href={gearListHref({ lens_model: lens.lens_model })} className="flex min-h-11 flex-wrap items-center justify-between gap-3 p-4 text-emerald-900"><span className="min-w-0 break-words font-semibold">{lens.lens_model}</span><span className="text-sm text-stone-600">{lens.count} Photos · {lens.percentage.toFixed(1)}%</span></Link></li>)}</ul> : <p>No lenses{search ? " match your search" : " identified"}.</p>}
          </section>
        </div>
        <nav aria-label="Equipment pages" className="mt-5 flex flex-wrap items-center gap-3 text-sm">
          <button disabled={page === 1} onClick={() => setPage(page - 1)} className="min-h-11 rounded border px-4 disabled:opacity-50">Previous equipment</button><span>Page {page} of {Math.max(1, Math.ceil(Math.max(data.camera_total, data.lens_total) / data.page_size))}</span><button disabled={page * data.page_size >= Math.max(data.camera_total, data.lens_total)} onClick={() => setPage(page + 1)} className="min-h-11 rounded border px-4 disabled:opacity-50">Next equipment</button>
        </nav>
      </>}
    </div>
  </main>;
}
