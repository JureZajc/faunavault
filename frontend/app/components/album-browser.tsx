"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlbumSummary,
  getSpeciesAlbums,
  getTaxonomyFilters,
  imageUrl,
  reconcileTaxonomy,
  TaxonomyFilters,
} from "../lib/api";

type AlbumSort = "name" | "newest" | "animal_count" | "photo_count";

const emptyFilters: TaxonomyFilters = {
  classes: [],
  orders: [],
  families: [],
  genera: [],
  species: [],
};

function initialParam(name: string, fallback = "") {
  if (typeof window === "undefined") return fallback;
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function AlbumCard({ album }: { album: AlbumSummary }) {
  const [imageFailed, setImageFailed] = useState(false);
  const title = album.common_name || album.scientific_name;
  return (
    <article className="group overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
      <Link href={`/albums/${encodeURIComponent(album.album_key)}`}>
        <div className="aspect-[4/3] overflow-hidden bg-stone-100">
          {album.cover_thumbnail_filename && !imageFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl("thumbs", album.cover_thumbnail_filename)}
              alt={title}
              loading="lazy"
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-gradient-to-br from-emerald-50 to-stone-100 px-5 text-center text-sm font-medium text-stone-500">
              No photograph available
            </div>
          )}
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                title={title}
                className="truncate text-lg font-semibold text-stone-950"
              >
                {title}
              </h2>
              <p
                title={
                  album.common_name
                    ? album.scientific_name
                    : album.verified
                      ? "Scientific name"
                      : "Legacy species name"
                }
                className="mt-1 truncate text-sm italic text-stone-500"
              >
                {album.common_name ? album.scientific_name : album.verified ? "Scientific name" : "Legacy species name"}
              </p>
            </div>
            {!album.verified ? (
              <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
                Unverified
              </span>
            ) : null}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <span className="rounded-md bg-stone-50 px-3 py-2 text-stone-600">
              <strong className="text-stone-900">{album.animal_count}</strong>{" "}
              {album.animal_count === 1 ? "animal" : "animals"}
            </span>
            <span className="rounded-md bg-stone-50 px-3 py-2 text-stone-600">
              <strong className="text-stone-900">{album.photo_count}</strong>{" "}
              {album.photo_count === 1 ? "photo" : "photos"}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}

export default function AlbumBrowser() {
  const [items, setItems] = useState<AlbumSummary[]>([]);
  const [filters, setFilters] = useState<TaxonomyFilters>(emptyFilters);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(() => Number(initialParam("page", "1")) || 1);
  const [query, setQuery] = useState(() => initialParam("q"));
  const [taxonomicClass, setTaxonomicClass] = useState(() => initialParam("class"));
  const [order, setOrder] = useState(() => initialParam("order"));
  const [family, setFamily] = useState(() => initialParam("family"));
  const [genus, setGenus] = useState(() => initialParam("genus"));
  const [species, setSpecies] = useState(() => initialParam("species"));
  const [onlyWithPhotos, setOnlyWithPhotos] = useState(
    () => initialParam("withPhotos") === "1",
  );
  const [sort, setSort] = useState<AlbumSort>(
    () => (initialParam("sort", "name") as AlbumSort),
  );
  const [isLoading, setIsLoading] = useState(true);
  const [isReconciling, setIsReconciling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => {
    const next = new URLSearchParams();
    next.set("page", String(page));
    next.set("page_size", "24");
    next.set("sort", sort);
    if (query.trim()) next.set("q", query.trim());
    if (taxonomicClass) next.set("class", taxonomicClass);
    if (order) next.set("order", order);
    if (family) next.set("family", family);
    if (genus) next.set("genus", genus);
    if (species) next.set("species", species);
    if (onlyWithPhotos) next.set("only_with_photos", "true");
    return next;
  }, [family, genus, onlyWithPhotos, order, page, query, sort, species, taxonomicClass]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getSpeciesAlbums(params);
      setItems(result.items);
      setTotal(result.total);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load albums");
    } finally {
      setIsLoading(false);
    }
  }, [params]);

  useEffect(() => {
    getTaxonomyFilters().then(setFilters).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    const url = new URL(window.location.href);
    url.searchParams.set("view", "album");
    for (const key of ["q", "class", "order", "family", "genus", "species", "withPhotos", "sort", "page"]) {
      url.searchParams.delete(key);
    }
    if (query.trim()) url.searchParams.set("q", query.trim());
    if (taxonomicClass) url.searchParams.set("class", taxonomicClass);
    if (order) url.searchParams.set("order", order);
    if (family) url.searchParams.set("family", family);
    if (genus) url.searchParams.set("genus", genus);
    if (species) url.searchParams.set("species", species);
    if (onlyWithPhotos) url.searchParams.set("withPhotos", "1");
    if (sort !== "name") url.searchParams.set("sort", sort);
    if (page > 1) url.searchParams.set("page", String(page));
    window.history.replaceState(null, "", url);
    return () => window.clearTimeout(timer);
  }, [family, genus, load, onlyWithPhotos, order, page, query, sort, species, taxonomicClass]);

  function updateFilter(setter: (value: string) => void, value: string) {
    setter(value);
    setPage(1);
  }

  async function handleReconcile() {
    setIsReconciling(true);
    setNotice(null);
    try {
      const result = await reconcileTaxonomy();
      setNotice(`${result.linked} linked, ${result.ambiguous} ambiguous, ${result.unmatched} unmatched, ${result.failed} failed.`);
      setPage(1);
      await Promise.all([
        page === 1 ? load() : Promise.resolve(),
        getTaxonomyFilters().then(setFilters),
      ]);
    } catch (nextError) {
      setNotice(nextError instanceof Error ? nextError.message : "Taxonomy matching failed");
    } finally {
      setIsReconciling(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 24));
  return (
    <div>
      <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="xl:col-span-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Search albums
            </span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Common or scientific name"
              type="search"
              className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm outline-none focus:border-emerald-500 focus:bg-white"
            />
          </label>
          <label>
            <span className="text-xs font-semibold uppercase tracking-wider text-stone-500">
              Sort
            </span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as AlbumSort);
                setPage(1);
              }}
              className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm"
            >
              <option value="name">Name</option>
              <option value="newest">Newest addition</option>
              <option value="animal_count">Number of animals</option>
              <option value="photo_count">Number of photographs</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-stone-700 md:items-end md:pb-2">
            <input
              type="checkbox"
              checked={onlyWithPhotos}
              onChange={(event) => {
                setOnlyWithPhotos(event.target.checked);
                setPage(1);
              }}
              className="h-4 w-4 accent-emerald-800"
            />
            Only with photos
          </label>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {([
            ["Class", filters.classes, taxonomicClass, setTaxonomicClass],
            ["Order", filters.orders, order, setOrder],
            ["Family", filters.families, family, setFamily],
            ["Genus", filters.genera, genus, setGenus],
            ["Species", filters.species, species, setSpecies],
          ] as const).map(([label, options, value, setter]) => (
            <label key={label}>
              <span className="sr-only">{label}</span>
              <select
                value={value}
                onChange={(event) =>
                  updateFilter(setter, event.target.value)
                }
                className="min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-2 text-sm"
              >
                <option value="">All {label.toLowerCase()}</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value} ({option.count})
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-3 border-t border-stone-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-stone-500">
            {total} species {total === 1 ? "album" : "albums"}
          </p>
          <button
            type="button"
            onClick={() => void handleReconcile()}
            disabled={isReconciling}
            className="min-h-11 rounded-md border border-amber-300 bg-amber-50 px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
          >
            {isReconciling ? "Matching with GBIF…" : "Match unverified names"}
          </button>
        </div>
        {notice ? (
          <p className="mt-3 break-words rounded-md bg-stone-50 px-3 py-2 text-sm text-stone-700">
            {notice}
          </p>
        ) : null}
      </div>
      {error ? (
        <div className="mt-6 break-words rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}{" "}
          <button
            onClick={() => void load()}
            className="min-h-10 px-2 font-semibold underline"
          >
            Retry
          </button>
        </div>
      ) : null}
      {isLoading ? (
        <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <div
              key={index}
              className="h-80 animate-pulse rounded-xl bg-white"
            />
          ))}
        </div>
      ) : items.length ? (
        <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((album) => (
            <AlbumCard key={album.album_key} album={album} />
          ))}
        </div>
      ) : (
        <div className="my-8 rounded-xl border border-dashed border-stone-300 bg-white px-4 py-12 text-center sm:px-6 sm:py-16">
          <h2 className="text-xl font-semibold">No species albums found</h2>
          <p className="mt-2 text-sm text-stone-500">
            Try clearing filters or add photographs to the collection.
          </p>
        </div>
      )}
      {totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-center gap-3 pb-10">
          <button
            disabled={page === 1}
            onClick={() => setPage((value) => value - 1)}
            className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-sm text-stone-600">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page === totalPages}
            onClick={() => setPage((value) => value + 1)}
            className="min-h-11 rounded-md border bg-white px-4 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
