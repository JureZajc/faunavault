"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getPhoto, Photo } from "../lib/api";
import { usePhotoCuration } from "./use-photo-curation";

export function useComparePhoto(id: number) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [stale, setStale] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const saving = useRef(false);

  const load = useCallback(async (initial = false, duringSave = false) => {
    if (pending.current || (saving.current && !duringSave)) return;
    pending.current = true;
    const token = ++sequence.current;
    const nextController = new AbortController();
    controller.current = nextController;
    if (initial) setLoading(true);
    setRefreshing(true);
    try {
      const next = await getPhoto(String(id), nextController.signal);
      if (nextController.signal.aborted || token !== sequence.current) return;
      if (next.deleted_at) { setPhoto(null); setUnavailable(true); }
      else { setPhoto(next); setUnavailable(false); }
      setStale(false); setLoadError(null);
    } catch (error) {
      if (nextController.signal.aborted || token !== sequence.current) return;
      if (error instanceof ApiError && error.status === 404) {
        setPhoto(null); setUnavailable(true); setStale(false); setLoadError(null);
      } else {
        setStale(true);
        setLoadError(`Could not refresh photo: ${error instanceof Error ? error.message : "Please try again."}`);
      }
    } finally {
      if (token === sequence.current) { pending.current = false; setLoading(false); setRefreshing(false); }
    }
  }, [id]);

  useEffect(() => {
    const requestSequence = sequence;
    const timer = window.setTimeout(() => void load(true), 0);
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(timer); window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      requestSequence.current++; controller.current?.abort(); pending.current = false;
    };
  }, [load]);

  const curation = usePhotoCuration({
    photo, disabled: loading || stale || unavailable,
    onPhotoUpdated: setPhoto, onError: setActionError,
    onBusyChange: (busy) => { saving.current = busy; },
    beforeSave: () => {
      sequence.current++; controller.current?.abort(); pending.current = false; setRefreshing(false);
    },
    onFailure: async (error) => {
      if (error instanceof ApiError && error.status === 404) {
        setPhoto(null); setUnavailable(true);
      } else {
        // A failed response may have followed a committed write. Read confirmed state before another action.
        await load(false, true);
      }
    },
  });
  return { photo, loading, refreshing, unavailable, stale, error: actionError ?? loadError, loadError, ...curation,
    refresh: () => { setActionError(null); return load(); } };
}
