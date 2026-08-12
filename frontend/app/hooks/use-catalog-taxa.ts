"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CatalogTaxonOption,
  getCatalogTaxa,
} from "../lib/api";

export function useCatalogTaxa(selectedId?: number) {
  const [items, setItems] = useState<CatalogTaxonOption[]>([]);
  const [selected, setSelected] = useState<CatalogTaxonOption | null>(null);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const loadPage = useCallback(
    async (nextPage: number) => {
      const nextRequestId = requestId.current + 1;
      requestId.current = nextRequestId;
      setIsLoading(true);
      setError(null);
      try {
        const result = await getCatalogTaxa(nextPage, 50, selectedId);
        if (nextRequestId !== requestId.current) return;
        setItems((current) => {
          const combined = nextPage === 1 ? result.items : [...current, ...result.items];
          return Array.from(
            new Map(combined.map((item) => [item.taxon_id, item])).values(),
          );
        });
        setSelected(result.selected);
        setPage(result.page);
        setTotalPages(result.total_pages);
      } catch (nextError) {
        if (nextRequestId !== requestId.current) return;
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Could not load verified taxa",
        );
      } finally {
        if (nextRequestId === requestId.current) setIsLoading(false);
      }
    },
    [selectedId],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      requestId.current += 1;
      setItems([]);
      setSelected(null);
      setPage(0);
      setTotalPages(0);
      setError(null);
      if (selectedId) void loadPage(1);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadPage, selectedId]);

  return {
    items,
    selected,
    isLoading,
    error,
    isLoaded: page > 0,
    hasMore: page > 0 && page < totalPages,
    load: () => loadPage(1),
    loadMore: () => loadPage(page + 1),
  };
}
