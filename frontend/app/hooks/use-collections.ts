"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CollectionSummary, getCollections } from "../lib/api";

export function useCollections(loadImmediately = true) {
  const [items, setItems] = useState<CollectionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(loadImmediately);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getCollections(next.signal);
      if (!next.signal.aborted) setItems(result);
      return result;
    } catch (nextError) {
      if (next.signal.aborted) return [];
      const message =
        nextError instanceof Error ? nextError.message : "Could not load Collections";
      setError(message);
      throw nextError;
    } finally {
      if (!next.signal.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!loadImmediately) return;
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
    };
  }, [load, loadImmediately]);

  return { items, setItems, isLoading, error, load };
}
