"use client";

import { FormEvent, useCallback, useId, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { useSightingResource } from "../../hooks/use-sighting-resource";
import { createSighting, getSightingSelection, Sighting, SightingMetadata, SightingSelection, SightingTaxon, updateSighting } from "../../lib/api";
import { editableUtcOffset, parseCaptureFields, parseLocationFields } from "../../lib/photo-metadata";
import GpsLocationPicker from "../maps/gps-location-picker";
import PhotoThumbnailPreview from "../photo-thumbnail-preview";
import { buttonStyle, inputStyle, LocalSpeciesPicker, primaryStyle, SightingError } from "./sighting-controls";

type Props = { onClose: () => void; onSaved: (item: Sighting) => void } & (
  { photoIds: number[]; item?: never } | { item: Sighting; photoIds?: never }
);

export default function SightingFormDialog(props: Props) {
  const { item, photoIds, onClose, onSaved } = props;
  const load = useCallback((signal: AbortSignal) => photoIds ? getSightingSelection(photoIds, signal) : Promise.resolve(null), [photoIds]);
  const { data: selection, error, retry } = useSightingResource(load);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef, initialFocusRef: headingRef, onClose, isBusy: busy });
  const title = item ? "Edit Sighting" : "Create Sighting";

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/50 p-3">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={handleKeyDown}
      className="max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-lg bg-white p-4 shadow-xl sm:p-6">
      <h2 id={id} ref={headingRef} tabIndex={-1} className="text-xl font-semibold">{title}</h2>
      {item || selection ? <SightingForm item={item} selection={selection ?? undefined} busy={busy} onClose={onClose}
        onSave={async (metadata) => {
          setBusy(true);
          try { onSaved(item ? await updateSighting(item.id, metadata) : await createSighting(metadata, photoIds)); }
          finally { setBusy(false); }
        }} /> : <>
        {error ? <SightingError message={error} retry={retry} /> : <p role="status" className="my-3">Loading selected photos…</p>}
        <button type="button" onClick={onClose} className={buttonStyle}>Cancel</button>
      </>}
    </div>
  </div>;
}

function SightingForm({ item, selection, busy, onClose, onSave }: {
  item?: Sighting; selection?: SightingSelection; busy: boolean;
  onClose: () => void; onSave: (fields: SightingMetadata) => Promise<void>;
}) {
  const initial = item ?? selection;
  const initialTime = initial?.observed_at ?? "";
  // datetime-local controls display milliseconds at most. Keep the original
  // precision when saving an unchanged value.
  const displayedTime = initialTime.slice(0, 23);
  const [subject, setSubject] = useState(item?.subject_label ?? "");
  const [taxon, setTaxon] = useState<SightingTaxon | null>(item?.taxon ?? null);
  const [observedAt, setObservedAt] = useState(displayedTime);
  const [offset, setOffset] = useState(editableUtcOffset(initial?.observed_at_offset_minutes ?? null));
  const [latitude, setLatitude] = useState(String(initial?.latitude ?? ""));
  const [longitude, setLongitude] = useState(String(initial?.longitude ?? ""));
  const [location, setLocation] = useState(item?.location_label ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const id = useId();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    setError(null);
    saving.current = true;
    try {
      if (!observedAt) throw new Error("Enter the field-local observation date and time.");
      const entered = parseCaptureFields(observedAt, offset);
      if (!entered.captured_at) throw new Error("Enter the field-local observation date and time.");
      const normalizedInitial = parseCaptureFields(displayedTime, "").captured_at;
      await onSave({
        subject_label: subject.trim() || null,
        taxon_id: taxon?.id ?? null,
        observed_at: entered.captured_at === normalizedInitial ? initialTime : entered.captured_at,
        observed_at_offset_minutes: entered.captured_at_offset_minutes,
        ...parseLocationFields(latitude, longitude),
        location_label: location.trim() || null,
        notes: notes.trim() || null,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace("camera-local capture date/time", "field-local observation date and time") : "Could not save the sighting.");
    } finally {
      saving.current = false;
    }
  }

  return <form className="mt-3 space-y-4" onSubmit={submit}>
    {selection && <section aria-label="Selected photos" className="space-y-2">
      <p className="text-sm font-semibold">{selection.photo_count} selected photos</p>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {selection.previews.map((photo) => <PhotoThumbnailPreview key={photo.id} preview={photo} />)}
      </div>
      {selection.photo_count > selection.previews.length && <p className="text-sm">+{selection.photo_count - selection.previews.length} more selected</p>}
      <p id={`${id}-suggestion`} className="text-sm text-stone-600">{selection.observed_at
        ? "The selected photos agree on the capture time. Review the suggested observation time."
        : selection.capture_times_differ ? "The selected photos have different capture times. Choose the encounter date and time."
        : "No shared capture time is available. Enter the encounter date and time."}</p>
    </section>}
    <fieldset disabled={busy} className="min-w-0 space-y-3">
      <legend className="sr-only">Observation details</legend>
      <label className="block text-sm font-semibold">Subject label <span className="font-normal">(optional)</span>
        <input className={inputStyle} maxLength={100} value={subject} onChange={(event) => setSubject(event.target.value)} />
      </label>
      <LocalSpeciesPicker value={taxon} onChange={setTaxon} disabled={busy} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-sm font-semibold">Observation date and time
          <input className={inputStyle} type="datetime-local" step="any" required aria-describedby={selection ? `${id}-suggestion` : undefined}
            value={observedAt} onChange={(event) => setObservedAt(event.target.value)} />
          <span className="mt-1 block font-normal text-stone-600">Use the local time at the encounter.</span>
        </label>
        <label className="text-sm font-semibold">UTC offset <span className="font-normal">(optional)</span>
          <input className={inputStyle} maxLength={6} placeholder="+02:00" value={offset} onChange={(event) => setOffset(event.target.value)} />
        </label>
      </div>
      <label className="block text-sm font-semibold">Location label <span className="font-normal">(optional)</span>
        <input className={inputStyle} maxLength={200} value={location} onChange={(event) => setLocation(event.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold">Latitude <span className="font-normal">(optional)</span>
          <input className={inputStyle} inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} />
        </label>
        <label className="text-sm font-semibold">Longitude <span className="font-normal">(optional)</span>
          <input className={inputStyle} inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} />
        </label>
      </div>
      <GpsLocationPicker latitude={latitude} longitude={longitude} disabled={busy} onChange={(gps) => {
        setLatitude(String(gps.latitude)); setLongitude(String(gps.longitude));
      }} />
      <label className="block text-sm font-semibold">Field notes <span className="font-normal">(optional)</span>
        <textarea className={`${inputStyle} py-2`} rows={4} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
    </fieldset>
    {error && <SightingError message={error} />}
    <div className="flex flex-wrap justify-end gap-3">
      <button type="button" onClick={onClose} disabled={busy} className={buttonStyle}>Cancel</button>
      <button type="submit" disabled={busy} className={primaryStyle}>{busy ? "Saving…" : "Save Sighting"}</button>
    </div>
  </form>;
}
