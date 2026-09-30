"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogFacets, getCatalogFacets } from "../lib/api";

export function useCatalogFacets() {
  const [facets, setFacets] = useState<CatalogFacets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setError(null);
    try {
      const data = await getCatalogFacets(request.signal);
      if (!request.signal.aborted) setFacets(data);
    } catch {
      if (!request.signal.aborted) setError("Could not load filter options");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); };
  }, [load]);
  return { facets, error, retry: load };
}
