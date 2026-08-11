"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  getTrashPhotos,
  imageUrl,
  permanentlyDeleteTrashPhoto,
  Photo,
  restoreTrashPhoto,
} from "../lib/api";

type TrashBrowserProps = {
  onNotice: (message: string) => void;
  onRestored: (photo: Photo) => void | Promise<void>;
};

export default function TrashBrowser({
  onNotice,
  onRestored,
}: TrashBrowserProps) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Photo | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getTrashPhotos(page);
      if (result.items.length === 0 && page > 1 && result.total > 0) {
        setPage((value) => value - 1);
        return;
      }
      setPhotos(result.items);
      setTotal(result.total);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load Trash");
    } finally {
      setIsLoading(false);
    }
  }, [page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function restore(photo: Photo) {
    setBusyId(photo.id);
    setError(null);
    try {
      await restoreTrashPhoto(photo.id);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Restore failed");
      setBusyId(null);
      return;
    }

    setPhotos((current) => current.filter((item) => item.id !== photo.id));
    setTotal((value) => Math.max(0, value - 1));
    onNotice(`Restored ${photo.original_filename} to the catalog.`);
    try {
      await onRestored(photo);
    } catch (nextError) {
      const detail =
        nextError instanceof Error ? `: ${nextError.message}` : ".";
      setError(`Photo was restored, but the catalog could not be updated${detail}`);
    } finally {
      setBusyId(null);
    }
  }

  async function permanentlyDelete(event: FormEvent) {
    event.preventDefault();
    if (!deleteTarget || confirmation !== deleteTarget.original_filename) return;
    setBusyId(deleteTarget.id);
    setError(null);
    try {
      const result = await permanentlyDeleteTrashPhoto(deleteTarget.id);
      const filename = deleteTarget.original_filename;
      setPhotos((current) => current.filter((item) => item.id !== deleteTarget.id));
      setTotal((value) => Math.max(0, value - 1));
      setDeleteTarget(null);
      setConfirmation("");
      onNotice(
        result.missing_files
          ? `Permanently deleted ${filename}; ${result.missing_files} image variants were already missing.`
          : `Permanently deleted ${filename}.`,
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Permanent deletion failed");
    } finally {
      setBusyId(null);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / 24));
  if (isLoading) {
    return <div className="py-16 text-center text-stone-500">Loading Trash…</div>;
  }

  return (
    <div>
      <div className="mb-5">
        <h2 className="text-2xl font-semibold">Trash</h2>
        <p className="mt-1 text-sm text-stone-500">
          Deleted photos stay local until you permanently remove them.
        </p>
      </div>
      {error ? (
        <div className="mb-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      {photos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white p-16 text-center text-stone-500">
          Trash is empty.
        </div>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {photos.map((photo) => (
            <article key={photo.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl("thumbs", photo.thumbnail_filename)}
                alt={photo.display_title || photo.original_filename}
                loading="lazy"
                className="aspect-[4/3] w-full object-cover"
              />
              <div className="p-4">
                <h3 className="truncate font-semibold">
                  {photo.display_title || photo.common_name || photo.original_filename}
                </h3>
                <p className="mt-1 truncate text-xs text-stone-500">{photo.original_filename}</p>
                <div className="mt-4 grid gap-2">
                  <button
                    type="button"
                    disabled={busyId === photo.id}
                    onClick={() => void restore(photo)}
                    className="min-h-10 rounded-md bg-emerald-800 text-sm font-semibold text-white"
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    disabled={busyId === photo.id}
                    onClick={() => setDeleteTarget(photo)}
                    className="min-h-10 rounded-md border border-red-200 bg-red-50 text-sm font-semibold text-red-700"
                  >
                    Permanently delete
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {totalPages > 1 ? (
        <div className="mt-6 flex justify-center gap-3">
          <button disabled={page === 1} onClick={() => setPage((value) => value - 1)} className="rounded border bg-white px-4 py-2 disabled:opacity-40">Previous</button>
          <span className="py-2 text-sm">Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} className="rounded border bg-white px-4 py-2 disabled:opacity-40">Next</button>
        </div>
      ) : null}
      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 px-4">
          <form onSubmit={permanentlyDelete} role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title" className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h2 id="permanent-delete-title" className="text-xl font-semibold">Permanently delete photo?</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">This removes the record and all local image variants. Type <strong>{deleteTarget.original_filename}</strong> to confirm.</p>
            <input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-4 min-h-11 w-full rounded-md border px-3" aria-label="Filename confirmation" />
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button type="button" onClick={() => { setDeleteTarget(null); setConfirmation(""); }} className="min-h-11 rounded border">Cancel</button>
              <button type="submit" disabled={confirmation !== deleteTarget.original_filename || busyId === deleteTarget.id} className="min-h-11 rounded border border-red-200 bg-red-50 font-semibold text-red-700 disabled:opacity-40">Permanently delete</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
