"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const MAX_SELECTED_PHOTOS = 250;

export function useCatalogSelection(contextKey: string) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const contextKeyRef = useRef(contextKey);

  const reset = useCallback(() => {
    setSelectedIds(new Set());
    setIsSelecting(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (contextKeyRef.current === contextKey) return;
    contextKeyRef.current = contextKey;
    reset();
  }, [contextKey, reset]);

  const enter = useCallback(() => {
    setIsSelecting(true);
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    setError(null);
  }, []);

  const toggle = useCallback((photoId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(photoId)) {
        next.delete(photoId);
        setError(null);
        return next;
      }
      if (next.size >= MAX_SELECTED_PHOTOS) {
        setError(`Select no more than ${MAX_SELECTED_PHOTOS} photos at once.`);
        return current;
      }
      next.add(photoId);
      setError(null);
      return next;
    });
  }, []);

  const togglePage = useCallback((photoIds: number[]) => {
    setSelectedIds((current) => {
      const allSelected =
        photoIds.length > 0 && photoIds.every((photoId) => current.has(photoId));
      const next = new Set(current);
      if (allSelected) {
        photoIds.forEach((photoId) => next.delete(photoId));
        setError(null);
        return next;
      }
      photoIds.forEach((photoId) => next.add(photoId));
      if (next.size > MAX_SELECTED_PHOTOS) {
        setError(`Select no more than ${MAX_SELECTED_PHOTOS} photos at once.`);
        return current;
      }
      setError(null);
      return next;
    });
  }, []);

  return {
    isSelecting,
    selectedIds,
    selectedCount: selectedIds.size,
    error,
    enter,
    clear,
    reset,
    toggle,
    togglePage,
  };
}
