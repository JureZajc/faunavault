"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { useSightingResource } from "../../hooks/use-sighting-resource";
import { changeSightingPhotos, getSighting } from "../../lib/api";
import { sightingName } from "../../lib/sightings";
import { buttonStyle, primaryStyle, SightingError } from "./sighting-controls";

export default function AddToSighting({ id, selected, busy, onSelect, onBusyChange, onAdded }: {
  id: number; selected: ReadonlySet<number>; busy: boolean; onSelect: () => void;
  onBusyChange: (busy: boolean) => void; onAdded: () => void;
}) {
  const router = useRouter();
  const load = useCallback((signal: AbortSignal) => getSighting(id, signal), [id]);
  const { data, error, retry } = useSightingResource(load);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saving = useRef(false);
  const href = `/sightings/${id}`;

  async function add() {
    if (!selected.size || busy || saving.current) return;
    saving.current = true;
    onBusyChange(true);
    setSaveError(null);
    try {
      await changeSightingPhotos(id, [...selected].sort((a, b) => a - b), "add");
      onAdded();
      router.push(href);
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : "Could not add photos.");
    } finally {
      saving.current = false;
      onBusyChange(false);
    }
  }

  return <section aria-label="Add photos to sighting" className="mb-4 space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
    {error ? <SightingError message={error} retry={retry} /> : !data ? <p role="status">Loading sighting…</p> : <>
      <h2 className="break-words text-lg font-semibold">Add photos to {sightingName(data)}</h2>
      <p className="text-sm">Select the photos you want to link from List.</p>
    </>}
    <div className="flex flex-wrap gap-2">
      <Link href={href} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }} className={buttonStyle}>Back to sighting</Link>
      {data && <>
        <button type="button" disabled={busy} className={buttonStyle} onClick={onSelect}>Select photos to link</button>
        <button type="button" disabled={busy || !selected.size} className={primaryStyle} onClick={() => void add()}>Add {selected.size || ""} selected to sighting</button>
      </>}
    </div>
    {saveError && <SightingError message={saveError} />}
  </section>;
}
