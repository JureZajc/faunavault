"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPhotoMapPoints, PhotoMapPoint } from "../lib/api";

export function usePhotoMapPoints() {
  const [points, setPoints] = useState<PhotoMapPoint[] | null>(null);
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
    setPoints(null);
    try {
      const result = await getPhotoMapPoints(nextController.signal);
      if (nextRequestId === requestId.current) setPoints(result);
    } catch {
      if (
        !nextController.signal.aborted &&
        nextRequestId === requestId.current
      ) {
        setError("Could not load photo locations");
      }
    } finally {
      if (nextRequestId === requestId.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
      requestId.current += 1;
    };
  }, [load]);

  return { points, isLoading, error, retry: load };
}
