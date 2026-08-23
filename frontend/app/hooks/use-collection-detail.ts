"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CollectionDetail, getCollection } from "../lib/api";

export function useCollectionDetail(
  collectionId: number,
  page: number,
  onPageCorrection: (page: number) => void,
) {
  const [data, setData] = useState<CollectionDetail | null>(null);
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
    try {
      const result = await getCollection(
        collectionId,
        page,
        48,
        nextController.signal,
      );
      if (nextRequestId !== requestId.current) return null;
      const nearestPage = result.photos.total_pages || 1;
      if (page > nearestPage) {
        onPageCorrection(nearestPage);
        return null;
      }
      setData(result);
      return result;
    } catch (nextError) {
      if (nextController.signal.aborted || nextRequestId !== requestId.current) {
        return null;
      }
      const message =
        nextError instanceof Error
          ? nextError.message
          : "Could not load the Collection";
      setError(message);
      throw nextError;
    } finally {
      if (nextRequestId === requestId.current) setIsLoading(false);
    }
  }, [collectionId, onPageCorrection, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch(() => undefined), 0);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
    };
  }, [load]);

  return { data, setData, isLoading, error, refresh: load };
}
