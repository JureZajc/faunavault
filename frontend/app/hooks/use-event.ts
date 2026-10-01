"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArchiveEventDetail, getEvent } from "../lib/api";

export function useEvent(id: number | null, revision?: unknown) {
  const [data, setData] = useState<ArchiveEventDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const token = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController(); controller.current = next;
    const current = ++token.current;
    setLoading(true); setError(null); setData(null);
    if (id === null) { setError("Invalid Trip/Event ID."); setLoading(false); return; }
    try { const item = await getEvent(id, next.signal); if (token.current === current) setData(item); }
    catch (failure) { if (!next.signal.aborted && token.current === current) setError(failure instanceof Error ? failure.message : "Could not load Trip/Event."); }
    finally { if (token.current === current) setLoading(false); }
  }, [id]);
  useEffect(() => {
    const counter = token;
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); counter.current++; };
  }, [refresh, revision]);
  return { data: data?.id === id ? data : null, setData, error, loading, refresh };
}
