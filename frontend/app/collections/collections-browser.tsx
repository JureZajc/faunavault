"use client";

import Link from "next/link";
import { useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import CollectionNameDialog from "../components/collections/collection-name-dialog";
import DeleteCollectionDialog from "../components/collections/delete-collection-dialog";
import { useCollections } from "../hooks/use-collections";
import { createCollection, deleteCollection, renameCollection, CollectionSummary } from "../lib/api";

export default function CollectionsBrowser() {
  const collections = useCollections();
  const [nameTarget, setNameTarget] = useState<CollectionSummary | "create" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CollectionSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function saveName(name: string) {
    const saved = nameTarget === "create"
      ? await createCollection({ name })
      : await renameCollection(nameTarget!.id, { name });
    collections.setItems((current) => {
      const next = nameTarget === "create"
        ? [...current, saved]
        : current.map((item) => item.id === saved.id ? saved : item);
      return next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id);
    });
    setNotice(nameTarget === "create" ? `Created Collection “${saved.name}”.` : `Renamed Collection to “${saved.name}”.`);
    return saved;
  }

  return <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
    <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><ArchiveNavigation active="collections" /><p className="text-sm text-stone-500 lg:text-right">Manual photo groupings, separate from species Albums</p></div>
      <header className="mt-6 flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Manual organization</p><h1 className="mt-2 text-3xl font-semibold">Collections</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">Create named groups for printing, trips, favorites, or any organization you choose. Photos can appear in several Collections.</p></div>
        <button type="button" onClick={() => setNameTarget("create")} className="min-h-11 shrink-0 rounded-md bg-emerald-800 px-5 font-semibold text-white">Create Collection</button>
      </header>
      {notice ? <p role="status" className="mt-5 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p> : null}
      {collections.error ? <div role="alert" className="mt-6 rounded-md border border-red-200 bg-red-50 p-4 text-red-700">{collections.error} <button type="button" onClick={() => void collections.load()} className="font-semibold underline">Retry</button></div> : null}
      {collections.isLoading ? <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3"><div className="h-48 animate-pulse rounded-xl bg-white" /><div className="h-48 animate-pulse rounded-xl bg-white" /></div> : !collections.error && collections.items.length ? <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3">{collections.items.map((collection) => <article key={collection.id} className="flex min-w-0 flex-col rounded-xl border border-stone-200 bg-white p-5 shadow-sm"><Link href={`/collections/${collection.id}`} className="min-w-0 flex-1"><h2 className="break-words text-xl font-semibold hover:text-emerald-800">{collection.name}</h2><p className="mt-3 text-sm text-stone-500"><strong className="text-stone-800">{collection.active_photo_count}</strong> active {collection.active_photo_count === 1 ? "photo" : "photos"}</p></Link><div className="mt-5 grid grid-cols-2 gap-2 border-t border-stone-100 pt-4"><button type="button" onClick={() => setNameTarget(collection)} className="min-h-11 rounded-md border bg-white text-sm font-semibold">Rename</button><button type="button" onClick={() => setDeleteTarget(collection)} className="min-h-11 rounded-md border border-red-200 bg-red-50 text-sm font-semibold text-red-700">Delete Collection</button></div></article>)}</div> : !collections.error ? <div className="my-8 rounded-xl border border-dashed border-stone-300 bg-white px-4 py-14 text-center"><h2 className="text-xl font-semibold">No Collections yet</h2><p className="mt-2 text-sm text-stone-500">Create one, then add explicitly selected photos from List.</p></div> : null}
    </div>
    <CollectionNameDialog key={nameTarget === "create" ? "collection-name-create" : `collection-name-${nameTarget?.id ?? "closed"}`} mode={nameTarget === "create" ? "create" : "rename"} initialName={nameTarget && nameTarget !== "create" ? nameTarget.name : ""} isOpen={nameTarget !== null} onClose={() => setNameTarget(null)} onSave={saveName} />
    <DeleteCollectionDialog key={`collection-delete-${deleteTarget?.id ?? "closed"}`} collection={deleteTarget} onClose={() => setDeleteTarget(null)} onDelete={async () => { if (!deleteTarget) return; await deleteCollection(deleteTarget.id); collections.setItems((current) => current.filter((item) => item.id !== deleteTarget.id)); setNotice(`Deleted Collection “${deleteTarget.name}”. Its photos remain in FaunaVault.`); }} />
  </main>;
}
