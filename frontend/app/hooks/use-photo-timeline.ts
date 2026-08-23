"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPhotoTimeline, TimelineResponse } from "../lib/api";

export function usePhotoTimeline() {
  const [data, setData] = useState<TimelineResponse | null>(null);
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
      const result = await getPhotoTimeline(nextController.signal);
      if (nextRequestId === requestId.current) setData(result);
    } catch {
      if (
        !nextController.signal.aborted &&
        nextRequestId === requestId.current
      ) {
        setError("Could not load the photo timeline");
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

  return { data, isLoading, error, retry: load };
}
