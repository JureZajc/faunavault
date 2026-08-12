"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CatalogPhotoPage, getCatalogPhotos } from "../lib/api";
import { CatalogState } from "../lib/catalog-query";

export function usePhotoCatalog(
  query: CatalogState,
  onPageCorrection: (page: number) => void,
) {
  const [data, setData] = useState<CatalogPhotoPage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const nextRequestId = requestId.current + 1;
    requestId.current = nextRequestId;
    setIsLoading(true);
    setError(null);
    setData(null);
    try {
      const result = await getCatalogPhotos(query, nextController.signal);
      if (nextRequestId !== requestId.current) return;
      const nearestPage = result.total_pages === 0 ? 1 : result.total_pages;
      if (query.page > nearestPage) {
        onPageCorrection(nearestPage);
        return;
      }
      setData(result);
    } catch (nextError) {
      if (nextController.signal.aborted || nextRequestId !== requestId.current) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not load the catalog",
      );
      throw nextError;
    } finally {
      if (nextRequestId === requestId.current) setIsLoading(false);
    }
  }, [onPageCorrection, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
    };
  }, [load]);

  return { data, isLoading, error, refresh: load };
}
