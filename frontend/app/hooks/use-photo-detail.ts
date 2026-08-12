"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPhoto, Photo } from "../lib/api";

export function usePhotoDetail(id: string) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (initial: boolean) => {
      const nextRequestId = requestId.current + 1;
      requestId.current = nextRequestId;
      if (initial) {
        setIsLoading(true);
        setError(null);
      }
      try {
        const nextPhoto = await getPhoto(id);
        if (nextRequestId === requestId.current) setPhoto(nextPhoto);
        return nextPhoto;
      } catch (nextError) {
        if (initial && nextRequestId === requestId.current) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Could not load photo",
          );
        }
        throw nextError;
      } finally {
        if (initial && nextRequestId === requestId.current) setIsLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => void load(true).catch(() => undefined),
      0,
    );
    return () => {
      window.clearTimeout(timer);
      requestId.current += 1;
    };
  }, [load]);

  const refresh = useCallback(() => load(false), [load]);
  const replacePhoto = useCallback((nextPhoto: Photo) => {
    setPhoto(nextPhoto);
  }, []);

  return { photo, isLoading, error, refresh, replacePhoto };
}
