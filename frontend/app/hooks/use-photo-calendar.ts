"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarResponse, getPhotoCalendar } from "../lib/api";

export function usePhotoCalendar(year?: number) {
  const key = year ?? null;
  const [state, setState] = useState<{ key: number | null; data: CalendarResponse | null; error: string | null; loading: boolean }>({ key, data: null, error: null, loading: true });
  const [availableYears, setAvailableYears] = useState<number[]>([]);
  const controller = useRef<AbortController | null>(null);
  const requestId = useRef(0);
  const load = useCallback(async () => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const id = ++requestId.current;
    setState({ key: year ?? null, data: null, error: null, loading: true });
    try {
      const data = await getPhotoCalendar(year, next.signal);
      if (!next.signal.aborted && id === requestId.current) {
        setAvailableYears(data.available_years);
        setState({ key: year ?? null, data, error: null, loading: false });
      }
    } catch {
      if (!next.signal.aborted && id === requestId.current) setState({ key: year ?? null, data: null, error: "Could not load the photography calendar", loading: false });
    }
  }, [year]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); controller.current?.abort(); requestId.current += 1; };
  }, [load]);
  const matches = state.key === key;
  return { availableYears, data: matches ? state.data : null, error: matches ? state.error : null, loading: state.loading || !matches, retry: load };
}
