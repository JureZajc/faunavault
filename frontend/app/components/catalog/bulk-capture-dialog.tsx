"use client";

import { FormEvent, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import {
  applyBulkCapture, previewBulkCapture, BulkCaptureOperation,
  BulkCapturePreview, BulkCaptureResult, CaptureMetadataValues,
} from "../../lib/api";
import { formatUtcOffset, parseCaptureFields, parseLocationFields } from "../../lib/photo-metadata";
import GpsLocationPicker from "../maps/gps-location-picker";

const operations = {
  shift_time: "Shift capture time",
  set_capture: "Set capture date and time",
  set_gps: "Set GPS coordinates",
  remove_gps: "Remove GPS coordinates",
  clear_capture: "Clear capture metadata",
  restore_original: "Restore original metadata",
};
const inputClass = "mt-1 min-h-11 w-full min-w-0 rounded-md border border-stone-300 px-3";
const buttonClass = "min-h-11 rounded-md border px-4 font-semibold disabled:opacity-50";

function MetadataValue({ value }: { value: CaptureMetadataValues }) {
  return <>
    <p>{value.captured_at?.replace("T", " ") ?? "No capture time"}</p>
    <p>{value.captured_at_offset_minutes === null ? "Unknown UTC offset" : formatUtcOffset(value.captured_at_offset_minutes)}</p>
    <p>{value.latitude === null ? "No GPS" : `${value.latitude}, ${value.longitude}`}</p>
    <p className="text-xs text-stone-500">Capture: {value.capture_metadata_overridden ? "overridden / intentionally cleared" : "original"}; GPS: {value.location_metadata_overridden ? "overridden / intentionally cleared" : "original"}</p>
  </>;
}

type Props = {
  photoIds: number[];
  onClose: () => void;
  onSuccess: (result: BulkCaptureResult) => void;
};

export default function BulkCaptureDialog({ photoIds, onClose, onSuccess }: Props) {
  const [operation, setOperation] = useState<BulkCaptureOperation["operation"]>("shift_time");
  const [minutes, setMinutes] = useState("60");
  const [date, setDate] = useState("");
  const [offsetMode, setOffsetMode] = useState<"preserve" | "assign" | "unknown">("preserve");
  const [offset, setOffset] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [group, setGroup] = useState<"capture" | "location" | "both">("both");
  const [preview, setPreview] = useState<BulkCapturePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const operationRef = useRef<HTMLSelectElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef, initialFocusRef: operationRef, onClose, isBusy: busy !== null });

  function invalidate() {
    setPreview(null);
    setConfirmed(false);
    setError(null);
  }

  function change(): BulkCaptureOperation {
    if (operation === "shift_time") {
      if (!minutes.trim() || !Number.isSafeInteger(Number(minutes))) throw new Error("Enter a signed whole number of minutes.");
      return { operation, minutes: Number(minutes) };
    }
    if (operation === "set_capture") {
      if (!date.trim()) throw new Error("Enter a camera-local capture date and time.");
      if (offsetMode === "assign" && !offset.trim()) throw new Error("Enter a signed UTC offset or choose Unknown offset.");
      const parsed = parseCaptureFields(date, offsetMode === "assign" ? offset : "");
      if (offsetMode === "preserve") return { operation, captured_at: parsed.captured_at!, offset_mode: "preserve" };
      return { operation, captured_at: parsed.captured_at!, offset_mode: "assign", captured_at_offset_minutes: parsed.captured_at_offset_minutes };
    }
    if (operation === "set_gps") {
      const parsed = parseLocationFields(latitude, longitude);
      if (parsed.latitude === null || parsed.longitude === null) throw new Error("Enter both latitude and longitude.");
      return { operation, latitude: parsed.latitude, longitude: parsed.longitude };
    }
    if (operation === "restore_original") return { operation, group };
    return { operation };
  }

  async function previewChanges(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    invalidate();
    try {
      const configured = change();
      inFlight.current = true;
      setBusy("preview");
      const result = await previewBulkCapture({ photo_ids: photoIds, change: configured });
      setPreview(result);
      requestAnimationFrame(() => previewHeadingRef.current?.focus());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not preview changes.");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function applyChanges() {
    if (inFlight.current || !preview?.can_apply || !confirmed) return;
    inFlight.current = true;
    setBusy("apply");
    setError(null);
    try {
      const result = await applyBulkCapture({ photo_ids: photoIds, change: preview.change, expected_versions: preview.photos.map(({ photo_id, updated_at, original_sha256 }) => ({ photo_id, updated_at, original_sha256 })) });
      onSuccess(result);
    } catch (failure) {
      setPreview(null);
      setConfirmed(false);
      setError(`${failure instanceof Error ? failure.message : "Could not apply changes."} Your selection is preserved. Preview changes again before applying.`);
      requestAnimationFrame(() => operationRef.current?.focus());
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-950/40 p-3 sm:items-center sm:p-6">
    <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="bulk-capture-title" aria-describedby="bulk-capture-description" aria-busy={busy !== null} tabIndex={-1} onKeyDown={handleKeyDown} onSubmit={previewChanges} className="my-auto max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl overflow-y-auto rounded-lg bg-white p-4 shadow-xl sm:p-6">
      <h2 id="bulk-capture-title" className="text-xl font-semibold">Edit capture / GPS</h2>
      <p id="bulk-capture-description" className="mt-2 text-sm text-stone-600">{photoIds.length} selected photos. Times are camera-local; no timezone conversion. Preview is read-only. Original files and AI review decisions stay unchanged.</p>
      <fieldset disabled={busy !== null} onChange={invalidate} className="mt-4 space-y-3">
        <label className="block text-sm font-medium">Operation<select ref={operationRef} value={operation} onChange={(event) => setOperation(event.target.value as typeof operation)} className={inputClass}>{Object.entries(operations).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {operation === "shift_time" ? <><label className="block text-sm font-medium">Signed minutes<input value={minutes} onChange={(event) => setMinutes(event.target.value)} inputMode="numeric" className={inputClass} /></label><p className="text-sm text-stone-600">Positive adds time; negative subtracts. Each offset and relative time difference is preserved. Missing capture times block the entire operation; deselect those photos or set their times first.</p></> : null}
        {operation === "set_capture" ? <>
          <label className="block text-sm font-medium">Camera-local date and time<input placeholder="2026-10-13T12:30:00" value={date} onChange={(event) => setDate(event.target.value)} className={inputClass} /></label>
          <label className="block text-sm font-medium">UTC offset handling<select value={offsetMode} onChange={(event) => setOffsetMode(event.target.value as typeof offsetMode)} className={inputClass}><option value="preserve">Preserve each existing offset</option><option value="assign">Assign a specific offset</option><option value="unknown">Explicitly unknown offset</option></select></label>
          {offsetMode === "assign" ? <label className="block text-sm font-medium">UTC offset<input placeholder="+02:00" value={offset} onChange={(event) => setOffset(event.target.value)} className={inputClass} /></label> : null}
        </> : null}
        {operation === "set_gps" ? <><div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm font-medium">Latitude<input inputMode="decimal" value={latitude} onChange={(event) => setLatitude(event.target.value)} className={inputClass} /></label><label className="block text-sm font-medium">Longitude<input inputMode="decimal" value={longitude} onChange={(event) => setLongitude(event.target.value)} className={inputClass} /></label></div><GpsLocationPicker latitude={latitude} longitude={longitude} disabled={busy !== null} onChange={(coordinates) => {
          setLatitude(String(coordinates.latitude));
          setLongitude(String(coordinates.longitude));
          invalidate();
        }} /></> : null}
        {operation === "restore_original" ? <><label className="block text-sm font-medium">Restore group<select value={group} onChange={(event) => setGroup(event.target.value as typeof group)} className={inputClass}><option value="both">Capture time and GPS</option><option value="capture">Capture time only</option><option value="location">GPS only</option></select></label><p className="text-sm text-stone-600">Re-read and verify each original file. Missing, corrupted or changed originals block the entire operation. Original metadata may be empty.</p></> : null}
        {operation === "remove_gps" || operation === "clear_capture" ? <p className="text-sm text-stone-600">This intentional clear prevents EXIF backfills from restoring the cleared values. Retained extracted metadata remains available; use Restore original metadata to verify and restore it.</p> : null}
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={busy !== null} onClick={onClose} className={buttonClass}>Cancel</button><button type="submit" disabled={busy !== null} className={buttonClass}>{busy === "preview" ? "Previewing…" : "Preview changes"}</button></div>
      {error ? <p role="alert" className="mt-4 text-red-700">{error}</p> : null}
      {preview ? <section className="mt-5" aria-label="Metadata preview">
        <h3 ref={previewHeadingRef} tabIndex={-1} className="font-semibold">{operations[preview.change.operation]}: {preview.selected_count} selected, {preview.affected_count} affected, {preview.blocked_count} cannot be processed</h3>
        {preview.blocked_count ? <p role="alert" className="mt-2 text-red-700">The entire operation is blocked. Resolve the issues below and preview again.</p> : null}
        <p className="mt-2 text-sm text-stone-600 sm:hidden">Swipe or scroll the table sideways to compare Before and After.</p>
        <div role="region" aria-label="Before and after metadata" tabIndex={0} className="mt-3 overflow-x-auto rounded border"><table className="w-full min-w-[600px] text-left text-sm"><caption className="sr-only">Read-only before and after capture and GPS values</caption><thead><tr className="bg-stone-100"><th scope="col" className="p-3">Photo</th><th scope="col" className="p-3">Before</th><th scope="col" className="p-3">After</th></tr></thead><tbody>{preview.photos.map((photo) => <tr key={photo.photo_id} className="border-t align-top"><th scope="row" className="max-w-48 break-all p-3">{photo.filename}<p className="font-normal">{photo.issue ? "Blocked" : photo.changed ? "Changed" : "Unchanged"}</p></th><td className="p-3"><MetadataValue value={photo.before} /></td><td className="p-3">{photo.issue ? <p className="text-red-700">{photo.issue.message}</p> : photo.after ? <MetadataValue value={photo.after} /> : null}</td></tr>)}</tbody></table></div>
        <label className="mt-4 flex min-h-11 items-center gap-3"><input type="checkbox" checked={confirmed} disabled={busy !== null || !preview.can_apply} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the preview and confirm these changes.</label>
        <button type="button" disabled={busy !== null || !confirmed || !preview.can_apply} onClick={() => void applyChanges()} className={`${buttonClass} mt-3 bg-emerald-800 text-white`}>{busy === "apply" ? "Applying…" : "Apply changes"}</button>
      </section> : null}
    </form>
  </div>;
}
