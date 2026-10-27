"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useModalAccessibility } from "../../hooks/use-modal-accessibility";
import { downloadSelectedExport, estimateSelectedExport, prepareSelectedExport, SelectedExportEstimate } from "../../lib/api";

function formatBytes(bytes: number) {
  const unit = Math.min(3, Math.max(0, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024))));
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / 1024 ** unit)} ${["B", "KiB", "MiB", "GiB"][unit]}`;
}

export default function SelectedExportDialog({ photoIds, onClose }: { photoIds: number[]; onClose: () => void }) {
  const [includeMetadata, setIncludeMetadata] = useState(false);
  const [estimate, setEstimate] = useState<SelectedExportEstimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const [estimateAttempt, setEstimateAttempt] = useState(0);
  const dialogRef = useRef<HTMLFormElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const prepareController = useRef<AbortController | null>(null);
  const { handleKeyDown } = useModalAccessibility({ isOpen: true, dialogRef, initialFocusRef: cancelRef, onClose, isBusy: busy });

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setEstimate(null);
      setError(null);
      setDownloadRequested(false);
      estimateSelectedExport({ photo_ids: photoIds, mode: "originals", include_metadata: includeMetadata }, controller.signal)
        .then((value) => { if (!controller.signal.aborted) setEstimate(value); })
        .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not estimate export."); });
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [photoIds, includeMetadata, estimateAttempt]);

  useEffect(() => () => prepareController.current?.abort(), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !estimate) return;
    const controller = new AbortController();
    prepareController.current = controller;
    setBusy(true);
    setError(null);
    setDownloadRequested(false);
    try {
      const result = await prepareSelectedExport({ photo_ids: photoIds, mode: "originals", include_metadata: includeMetadata }, controller.signal);
      if (controller.signal.aborted) return;
      downloadSelectedExport(result.download_path);
      setDownloadRequested(true);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not prepare export. Please retry.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-stone-950/40 p-3 sm:p-6">
    <form ref={dialogRef} onSubmit={submit} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-labelledby="selected-export-title" aria-describedby="selected-export-description" aria-busy={busy} tabIndex={-1} className="my-auto w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
      <h2 id="selected-export-title" className="text-xl font-semibold">Export selected photos</h2>
      <p id="selected-export-description" className="mt-2 text-sm text-stone-600">Download only the {photoIds.length} explicitly selected {photoIds.length === 1 ? "photo" : "photos"} as a ZIP. Your selection and catalog filters stay in place.</p>
      <dl className="mt-4 text-sm"><dt className="font-semibold">Export mode</dt><dd>Original images · unchanged original bytes</dd></dl>
      <label className="mt-4 flex min-h-11 items-center gap-2 text-sm font-medium"><input type="checkbox" checked={includeMetadata} disabled={busy} onChange={(event) => { setEstimate(null); setIncludeMetadata(event.target.checked); }} className="h-5 w-5 accent-emerald-800" />Include metadata JSON manifest</label>
      <p className="mt-1 text-xs text-stone-600">The optional manifest includes capture dates, GPS when available, verified taxonomy, tags, Favorites, ratings, culling decisions, and checksums. Original files may also contain embedded GPS.</p>
      <p role="status" className="mt-4 text-sm">{busy ? "Preparing and verifying ZIP…" : downloadRequested ? "Download requested. Check your browser downloads. If it was interrupted, prepare another download." : estimate ? `Estimated total download size: ${formatBytes(estimate.estimated_download_bytes)}. ZIP headers and metadata may vary.` : error ? "Estimate unavailable." : "Estimating download size…"}</p>
      {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
      {error && !estimate ? <button type="button" onClick={() => setEstimateAttempt((value) => value + 1)} className="mt-2 min-h-11 text-sm font-semibold text-emerald-900 underline">Retry estimate</button> : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button ref={cancelRef} type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-md border border-stone-300 px-4 text-sm font-semibold disabled:opacity-50">{downloadRequested ? "Done" : "Cancel"}</button>
        <button type="submit" disabled={busy || !estimate} className="min-h-11 rounded-md bg-emerald-800 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Preparing…" : downloadRequested ? "Prepare another download" : "Confirm and download ZIP"}</button>
      </div>
    </form>
  </div>;
}
