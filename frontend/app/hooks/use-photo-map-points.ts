"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, getPhotoMapPoints, PhotoMapPoint } from "../lib/api";
import { MapCatalogQuery, mapCatalogQuery } from "../lib/catalog-query";

export function usePhotoMapPoints(query: MapCatalogQuery = {}, blocked = false) {
  const queryKey = JSON.stringify(mapCatalogQuery(query));
  const filters = useMemo(() => JSON.parse(queryKey) as MapCatalogQuery, [queryKey]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [points, setPoints] = useState<PhotoMapPoint[] | null>(null);
  const [hasMap, setHasMap] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (blocked) return;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    setIsLoading(true);
    setError(null);
    try {
      const result = await getPhotoMapPoints(filters, nextController.signal);
      if (nextRequestId === requestId.current) {
        setPoints(result);
        if (result.length) setHasMap(true);
        setLoadedKey(queryKey);
      }
    } catch (nextError) {
      if (
        !nextController.signal.aborted &&
        nextRequestId === requestId.current
      ) {
        setLoadedKey(queryKey);
        setError(nextError instanceof ApiError && nextError.status === 422
          ? nextError.message : "Could not load photo locations");
      }
    } finally {
      if (nextRequestId === requestId.current) setIsLoading(false);
    }
  }, [blocked, filters, queryKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const refresh = () => void load();
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
      requestId.current += 1;
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);

  return { points, hasMap, isLoading: !blocked && (isLoading || loadedKey !== queryKey),
    error: loadedKey === queryKey ? error : null, retry: load };
}
