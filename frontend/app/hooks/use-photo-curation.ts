"use client";

import { useEffect, useRef, useState } from "react";
import { Photo, PhotoUpdate, updatePhoto } from "../lib/api";

export function usePhotoCuration({ photo, disabled, onPhotoUpdated, onBusyChange, onError, beforeSave, onFailure }: {
  photo: Photo | null; disabled: boolean; onPhotoUpdated: (photo: Photo) => void;
  onBusyChange?: (busy: boolean) => void; onError: (message: string | null) => void;
  beforeSave?: () => void; onFailure?: (error: unknown) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const saving = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function save(values: PhotoUpdate) {
    if (!photo || disabled || saving.current) return;
    saving.current = true;
    beforeSave?.();
    setBusy(true); onBusyChange?.(true); onError(null); setNotice("");
    try {
      const saved = await updatePhoto(photo.id, values, photo.updated_at);
      if (!mounted.current) return;
      onPhotoUpdated(saved); setNotice("Saved");
    } catch (error) {
      if (!mounted.current) return;
      onError(`Could not save Photo curation: ${error instanceof Error ? error.message : "Please try again."}`);
      await onFailure?.(error);
    } finally {
      saving.current = false;
      if (mounted.current) { setBusy(false); onBusyChange?.(false); }
    }
  }
  return { busy, notice, save };
}
