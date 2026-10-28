"use client";

import { FormEvent, RefObject, useRef, useState } from "react";
import { useModalAccessibility } from "../hooks/use-modal-accessibility";
import { TagOperationPreview, TagOperationRequest, TagOperationResult, applyTagOperation, previewTagOperation } from "../lib/api";

const button = "min-h-11 rounded-md border border-stone-300 px-4 font-semibold disabled:opacity-50";

export default function TagOperationDialog({ operation, source, tags, onClose, onSuccess, fallbackFocusRef }: {
  operation: TagOperationRequest["operation"]; source: string; tags: string[];
  onClose: () => void; onSuccess: (result: TagOperationResult) => void;
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const [destination, setDestination] = useState("");
  const [preview, setPreview] = useState<TagOperationPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const destinationRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef, initialFocusRef: operation === "delete" ? cancelRef : destinationRef, fallbackFocusRef, onClose, isBusy: busy !== null });
  const title = operation === "rename" ? "Rename tag" : operation === "merge" ? "Merge tags" : "Delete tag";

  async function loadPreview(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("preview"); setError(null); setPreview(null); setConfirmed(false);
    try {
      const result = await previewTagOperation({ operation, source, ...(operation === "delete" ? {} : { destination }) });
      setPreview(result); setStale(false);
      requestAnimationFrame(() => previewRef.current?.focus());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not preview changes.");
    } finally { inFlight.current = false; setBusy(null); }
  }

  async function apply() {
    if (!preview || stale || inFlight.current || (operation === "delete" && !confirmed)) return;
    inFlight.current = true;
    setBusy("apply"); setError(null);
    try {
      const result = await applyTagOperation({ operation, source: preview.source, destination: preview.destination, preview_token: preview.preview_token, confirm_delete: confirmed });
      onSuccess(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not apply changes. Retry Preview to check the archive.");
      // Any uncertain submission must be re-previewed before another apply.
      setStale(true);
    } finally { inFlight.current = false; setBusy(null); }
  }

  return <div className="fixed inset-0 z-50 flex overflow-y-auto bg-stone-950/60 p-3 sm:p-6">
    <form ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="tag-operation-title" aria-describedby="tag-operation-description" aria-busy={busy !== null} tabIndex={-1} onKeyDown={handleKeyDown} onSubmit={loadPreview} className="my-auto max-h-[calc(100dvh-1.5rem)] w-full min-w-0 max-w-2xl overflow-y-auto rounded-xl bg-white p-4 shadow-xl sm:mx-auto sm:p-6">
      <h2 id="tag-operation-title" className={`text-xl font-semibold ${operation === "delete" ? "text-red-800" : ""}`}>{title}</h2>
      <p id="tag-operation-description" className="mt-2 text-sm text-stone-600">Affects the entire archive, including Trash. Tags are case-sensitive and whitespace-trimmed. Photos and review decisions are preserved.</p>
      <p className="mt-4 break-words">Source tag: <strong>{source}</strong></p>
      {operation !== "delete" && <label className="mt-4 block text-sm font-semibold">Destination tag
        <input ref={destinationRef} required maxLength={1000} list="tag-destinations" value={destination} disabled={busy !== null} onChange={(event) => { setDestination(event.target.value); setPreview(null); setError(null); setStale(false); setConfirmed(false); }} className="mt-2 min-h-11 w-full min-w-0 rounded-md border border-stone-300 px-3" />
        <datalist id="tag-destinations">{tags.filter((tag) => tag !== source).map((tag) => <option key={tag} value={tag} />)}</datalist>
        {operation === "merge" && <span className="mt-1 block font-normal text-stone-600">Choose an existing archive tag. A tag used only in Trash can also be entered.</span>}
      </label>}
      {preview && <section className={`mt-4 rounded-lg border p-3 ${operation === "delete" ? "border-red-300 bg-red-50" : "border-emerald-200 bg-emerald-50"}`}>
        <h3 ref={previewRef} tabIndex={-1} className="font-semibold">Preview changes</h3>
        <p className="mt-2 break-words">{preview.source}{preview.destination != null ? ` → ${preview.destination}` : " → removed"}</p>
        {preview.destination_exists && operation === "rename" && <p className="mt-2 font-semibold">The destination already exists. This rename will merge the source into the destination.</p>}
        <ul className="mt-2 text-sm">
          <li>{preview.active_photos} active Photos affected</li>
          <li>{preview.trashed_photos} Trashed Photos affected</li>
          <li>{preview.destination_overlap} affected Photos already contain the destination tag</li>
          <li className="font-semibold">{preview.total_photos} total Photos will be updated</li>
        </ul>
        <p className="mt-3 text-sm font-semibold">Representative before / after</p>
        <ul className="mt-1 space-y-3 text-sm">{preview.examples.map((example) => <li key={example.photo_id} className="min-w-0 break-words"><p>{example.filename}{example.trashed ? " (Trash)" : ""}</p><p>Before: {JSON.stringify(example.before)}</p><p>After: {JSON.stringify(example.after)}</p></li>)}</ul>
        {operation === "delete" && <label className="mt-4 flex min-h-11 items-center gap-3 font-semibold text-red-900"><input type="checkbox" checked={confirmed} disabled={busy !== null} onChange={(event) => setConfirmed(event.target.checked)} className="h-5 w-5 shrink-0" />Remove this tag from all affected Photos, including Trash.</label>}
      </section>}
      {error && <p role="alert" className="mt-4 break-words text-red-800">{error}{stale && " Refresh the preview to review current changes."}</p>}
      {busy && <p role="status" className="mt-4">{busy === "preview" ? "Loading preview…" : "Applying changes…"}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button ref={cancelRef} type="button" onClick={onClose} disabled={busy !== null} className={button}>Cancel</button>
        <button type="submit" disabled={busy !== null} className={button}>{stale ? "Retry Preview" : "Preview changes"}</button>
        {preview && <button type="button" onClick={() => void apply()} disabled={busy !== null || stale || (operation === "delete" && !confirmed)} className={`${button} ${operation === "delete" ? "border-red-700 bg-red-700 text-white" : "bg-emerald-800 text-white"}`}>{operation === "delete" ? "Confirm delete tag" : "Confirm changes"}</button>}
      </div>
    </form>
  </div>;
}
