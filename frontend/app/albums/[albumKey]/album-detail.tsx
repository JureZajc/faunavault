"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AnimalNameEditor from "../../components/animal-name-editor";
import ImageLightbox from "../../components/image-lightbox";
import MoveToTrashButton from "../../components/move-to-trash-button";
import SuccessNotice from "../../components/success-notice";
import {
  AlbumDetail,
  Animal,
  getSpeciesAlbum,
  imageUrl,
  Photo,
  searchTaxonomy,
  selectAlbumTaxon,
  TaxonCandidate,
} from "../../lib/api";

function hierarchy(album: AlbumDetail) {
  if (!album.taxonomy) return [];
  return [
    ["Kingdom", album.taxonomy.kingdom],
    ["Phylum", album.taxonomy.phylum],
    ["Class", album.taxonomy.class],
    ["Order", album.taxonomy.order],
    ["Family", album.taxonomy.family],
    ["Genus", album.taxonomy.genus],
    ["Species", album.taxonomy.species],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export default function AlbumDetailView({ albumKey }: { albumKey: string }) {
  const effectiveAlbumKey = useRef(albumKey);
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [taxonQuery, setTaxonQuery] = useState("");
  const [candidates, setCandidates] = useState<TaxonCandidate[]>([]);
  const [taxonomyWarning, setTaxonomyWarning] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [animalPage, setAnimalPage] = useState(1);
  const [photoPage, setPhotoPage] = useState(1);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const detailParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("animal_page", String(animalPage));
    params.set("animal_page_size", "50");
    params.set("photo_page", String(photoPage));
    params.set("photo_page_size", "24");
    return params;
  }, [animalPage, photoPage]);

  const load = useCallback(async (nextKey = effectiveAlbumKey.current) => {
    setIsLoading(true);
    setError(null);
    try {
      setAlbum(await getSpeciesAlbum(nextKey, detailParams));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load album");
    } finally {
      setIsLoading(false);
    }
  }, [detailParams]);

  useEffect(() => {
    effectiveAlbumKey.current = albumKey;
  }, [albumKey]);

  useEffect(() => {
    let mounted = true;
    getSpeciesAlbum(effectiveAlbumKey.current, detailParams)
      .then((result) => {
        if (mounted) setAlbum(result);
      })
      .catch((nextError: Error) => {
        if (mounted) setError(nextError.message);
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [albumKey, detailParams]);

  async function handleSearch() {
    if (taxonQuery.trim().length < 2) return;
    setIsSearching(true);
    setTaxonomyWarning(null);
    try {
      const result = await searchTaxonomy(taxonQuery.trim());
      setCandidates(result.results);
      setTaxonomyWarning(result.warning);
    } catch (nextError) {
      setTaxonomyWarning(nextError instanceof Error ? nextError.message : "GBIF search failed");
      setCandidates([]);
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSelect(candidate: TaxonCandidate) {
    if (!album || !window.confirm(`Link all ${album.animal_count} animals in this album to ${candidate.canonical_name}?`)) return;
    setIsSelecting(true);
    try {
      const result = await selectAlbumTaxon(album.album_key, candidate.external_taxon_id);
      effectiveAlbumKey.current = result.album_key;
      window.history.replaceState(null, "", `/albums/${encodeURIComponent(result.album_key)}`);
      await load(result.album_key);
      setCandidates([]);
    } catch (nextError) {
      setTaxonomyWarning(nextError instanceof Error ? nextError.message : "Could not store taxonomy");
    } finally {
      setIsSelecting(false);
    }
  }

  function handleAnimalUpdated(updatedAnimal: Animal) {
    setAlbum((currentAlbum) =>
      currentAlbum
        ? {
            ...currentAlbum,
            animals: {
              ...currentAlbum.animals,
              items: currentAlbum.animals.items.map((animal) =>
                animal.id === updatedAnimal.id ? updatedAnimal : animal,
              ),
            },
          }
        : currentAlbum,
    );
  }

  async function handlePhotoMoved(photo: Photo) {
    setLightboxIndex(null);
    setSuccessNotice(`Moved ${photo.original_filename} to Trash.`);
    const wasLastItem = album?.photos.items.length === 1;
    setAlbum((current) =>
      current
        ? {
            ...current,
            photo_count: Math.max(0, current.photo_count - 1),
            photos: {
              ...current.photos,
              total: Math.max(0, current.photos.total - 1),
              items: current.photos.items.filter((item) => item.id !== photo.id),
            },
          }
        : current,
    );
    if (wasLastItem && photoPage > 1) {
      setPhotoPage((value) => value - 1);
    } else {
      await load();
    }
  }

  const lightboxImages = useMemo(() => album?.photos.items.map((photo) => {
    const animal = album.animals.items.find((item) => item.id === photo.animal_id);
    return {
      imageUrl: imageUrl("resized", photo.resized_filename || photo.stored_filename),
      alt: photo.display_title || photo.common_name || photo.original_filename,
      caption: [animal?.display_name || animal?.identifier, photo.original_filename, photo.description].filter(Boolean).join(" · "),
    };
  }) ?? [], [album]);

  if (isLoading) {
    return (
      <main className="min-h-screen bg-[#f7f8f4] p-4 sm:p-8">
        <div className="mx-auto h-[32rem] max-w-7xl animate-pulse rounded-xl bg-white" />
      </main>
    );
  }
  if (error || !album) {
    return (
      <main className="min-h-screen bg-[#f7f8f4] p-4 sm:p-8">
        <div className="mx-auto max-w-3xl break-words rounded-xl border border-red-200 bg-red-50 p-4 text-red-700 sm:p-6">
          {error || "Album not found"}{" "}
          <button
            onClick={() => void load()}
            className="min-h-10 px-2 font-semibold underline"
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  const title = album.common_name || album.scientific_name;
  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
        {successNotice ? (
          <SuccessNotice
            message={successNotice}
            onDismiss={() => setSuccessNotice(null)}
            onViewTrash={() => {
              window.location.href = "/?view=trash";
            }}
          />
        ) : null}
        <Link
          href="/?view=album"
          className="inline-flex min-h-10 items-center rounded-md border border-stone-200 bg-white px-3 text-sm font-medium text-stone-700 hover:border-emerald-300"
        >
          Back to albums
        </Link>
        <header className="mt-6 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                Species album
              </p>
              <h1 className="mt-2 break-words text-3xl font-semibold">
                {title}
              </h1>
              <p className="mt-1 break-words text-base italic text-stone-500">
                {album.common_name
                  ? album.scientific_name
                  : album.verified
                    ? "Scientific name"
                    : "Unverified legacy name"}
              </p>
            </div>
            {!album.verified ? <span className="w-fit rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-800">Needs taxonomy review</span> : null}
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            <span className="rounded-full bg-stone-100 px-3 py-1.5">
              {album.animal_count}{" "}
              {album.animal_count === 1 ? "animal" : "animals"}
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1.5">
              {album.photo_count}{" "}
              {album.photo_count === 1 ? "photograph" : "photographs"}
            </span>
          </div>
          {hierarchy(album).length ? (
            <dl className="mt-6 grid gap-3 border-t border-stone-100 pt-5 sm:grid-cols-2 lg:grid-cols-4">
              {hierarchy(album).map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs font-semibold uppercase tracking-wider text-stone-400">
                    {label}
                  </dt>
                  <dd className="mt-1 break-words text-sm text-stone-800">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </header>

        {!album.verified ? (
          <section className="mt-6 min-w-0 rounded-xl border border-amber-200 bg-amber-50/60 p-4 sm:p-5">
            <h2 className="text-lg font-semibold">Link this album to GBIF</h2>
            <p className="mt-1 text-sm text-stone-600">
              Search by common or scientific name. Nothing is assigned until you
              confirm a candidate.
            </p>
            <div className="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row">
              <input
                value={taxonQuery}
                onChange={(event) => setTaxonQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleSearch();
                }}
                placeholder="e.g. Panthera leo"
                className="min-h-11 min-w-0 flex-1 rounded-md border border-amber-200 bg-white px-3 text-sm outline-none focus:border-emerald-500"
              />
              <button
                disabled={isSearching || taxonQuery.trim().length < 2}
                onClick={() => void handleSearch()}
                className="min-h-11 rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white disabled:opacity-50"
              >
                {isSearching ? "Searching…" : "Search"}
              </button>
            </div>
            {taxonomyWarning ? (
              <p className="mt-3 break-words text-sm text-amber-900">
                {taxonomyWarning}
              </p>
            ) : null}
            {candidates.length ? (
              <div className="mt-4 grid gap-2">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.external_taxon_id}
                    disabled={isSelecting}
                    onClick={() => void handleSelect(candidate)}
                    className="flex min-h-11 min-w-0 flex-col items-start justify-between gap-2 rounded-lg border border-stone-200 bg-white p-3 text-left hover:border-emerald-400 sm:flex-row sm:items-center"
                  >
                    <span className="min-w-0 break-words">
                      <strong>
                        {candidate.common_name || candidate.canonical_name}
                      </strong>
                      <span className="ml-2 italic text-stone-500">
                        {candidate.scientific_name}
                      </span>
                      <span className="ml-2 text-xs text-stone-400">
                        {candidate.rank}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-emerald-800">
                      Select
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <div className="mt-8 grid gap-8 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside>
            <h2 className="text-lg font-semibold">Individuals</h2>
            <div className="mt-3 space-y-2">
              {album.animals.items.map((animal) => (
                <div
                  key={animal.id}
                  className="rounded-lg border border-stone-200 bg-white p-3"
                >
                  <AnimalNameEditor
                    animal={animal}
                    onUpdated={handleAnimalUpdated}
                  />
                  <p className="mt-2 text-xs capitalize text-stone-500">
                    {animal.taxonomy_status.replaceAll("_", " ")}
                  </p>
                </div>
              ))}
            </div>
            {album.animals.total > album.animals.page_size ? (
              <div className="mt-3 flex gap-2">
                <button
                  disabled={animalPage === 1}
                  onClick={() => setAnimalPage((value) => value - 1)}
                  className="min-h-10 rounded border bg-white px-3 text-xs disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  disabled={
                    animalPage * album.animals.page_size >= album.animals.total
                  }
                  onClick={() => setAnimalPage((value) => value + 1)}
                  className="min-h-10 rounded border bg-white px-3 text-xs disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            ) : null}
          </aside>
          <section className="min-w-0">
            <h2 className="text-lg font-semibold">Photographs</h2>
            {album.photos.items.length ? (
              <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {album.photos.items.map((photo, index) => (
                  <article key={photo.id} className="min-w-0 overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
                    <button type="button" onClick={() => setLightboxIndex(index)} className="group block w-full min-w-0 text-left">
                      <div className="aspect-[4/3] bg-stone-100">
                        {/* eslint-disable-next-line @next/next/no-img-element -- Backend localhost images bypass Next optimization. */}
                        <img src={imageUrl("thumbs", photo.thumbnail_filename)} alt={photo.display_title || photo.original_filename} loading="lazy" className="h-full w-full object-cover" />
                      </div>
                      <div className="min-w-0 p-3 pb-2">
                        <p
                          title={
                            photo.display_title ||
                            photo.common_name ||
                            photo.original_filename
                          }
                          className="truncate text-sm font-semibold"
                        >
                          {photo.display_title ||
                            photo.common_name ||
                            photo.original_filename}
                        </p>
                        <p
                          title={photo.original_filename}
                          className="mt-1 truncate text-xs text-stone-500"
                        >
                          {photo.original_filename}
                        </p>
                      </div>
                    </button>
                    <div className="px-3 pb-3">
                      <MoveToTrashButton
                        photo={photo}
                        onMoved={handlePhotoMoved}
                        onError={setError}
                        className="min-h-10 w-full rounded-md border border-stone-200 text-xs font-semibold text-stone-600 hover:border-red-200 hover:text-red-700"
                      />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="mt-3 rounded-xl border border-dashed border-stone-300 bg-white px-4 py-12 text-center text-stone-500 sm:p-12">
                No photographs for this species.
              </div>
            )}
            {album.photos.total > album.photos.page_size ? (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <button
                  disabled={photoPage === 1}
                  onClick={() => setPhotoPage((value) => value - 1)}
                  className="min-h-11 rounded border bg-white px-3 text-sm disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  disabled={
                    photoPage * album.photos.page_size >= album.photos.total
                  }
                  onClick={() => setPhotoPage((value) => value + 1)}
                  className="min-h-11 rounded border bg-white px-3 text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            ) : null}
          </section>
        </div>
      </div>
      {lightboxIndex !== null ? (
        <ImageLightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      ) : null}
    </main>
  );
}
