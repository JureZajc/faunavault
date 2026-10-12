"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getInsights, InsightsResponse } from "../lib/api";

export function useInsights(year?: number) {
  const [state, setState] = useState<{ data: InsightsResponse | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const requestId = useRef(0);
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const id = ++requestId.current;
    setState({ data: null, error: null, loading: true });
    try {
      const data = await getInsights(year, next.signal);
      if (!next.signal.aborted && id === requestId.current) {
        setAvailableYears(data.available_years);
        setState({ data, error: null, loading: false });
      }
    } catch {
      if (!next.signal.aborted && id === requestId.current) setState({ data: null, error: "Could not load Wildlife Insights", loading: false });
    }
  }, [year]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      controller.current?.abort();
      requestId.current += 1;
    };
  }, [load]);
  // Hide the previous period immediately, even before the effect starts fetching.
  const matches = state.data?.year === (year ?? null);
  return { ...state, availableYears, data: matches ? state.data : null, loading: state.loading || Boolean(state.data && !matches), retry: load };
}
