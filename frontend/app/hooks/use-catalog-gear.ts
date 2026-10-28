"use client";

import { useCallback, useEffect, useState } from "react";
import { CatalogGear, getCatalogGear } from "../lib/api";

export function useCatalogGear(search = "", sort = "name", page = 1, enabled = true) {
  const [data, setData] = useState<CatalogGear | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [resolvedKey, setResolvedKey] = useState("");
  const requestKey = JSON.stringify([search, sort, page, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      void getCatalogGear(search, sort, page, controller.signal).then((result) => {
        if (!controller.signal.aborted) setData(result);
      }).catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load equipment");
      }).finally(() => { if (!controller.signal.aborted) { setLoading(false); setResolvedKey(requestKey); } });
    }, 200);
    window.addEventListener("focus", retry);
    return () => { window.clearTimeout(timer); controller.abort(); window.removeEventListener("focus", retry); };
  }, [search, sort, page, revision, retry, requestKey, enabled]);
  return { data, loading: enabled && (loading || resolvedKey !== requestKey), error, retry };
}
