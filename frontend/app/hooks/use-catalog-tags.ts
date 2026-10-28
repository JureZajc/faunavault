"use client";

import { useCallback, useEffect, useState } from "react";
import { CatalogTags, getCatalogTags } from "../lib/api";

export function notifyTagsChanged() {
  window.dispatchEvent(new Event("catalog-tags-changed"));
}

export function useCatalogTags(enabled = true) {
  const [data, setData] = useState<CatalogTags | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void getCatalogTags(controller.signal).then((result) => {
        if (!controller.signal.aborted) setData(result);
      }).catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load tags");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    const refresh = () => retry();
    window.addEventListener("focus", refresh);
    window.addEventListener("catalog-tags-changed", refresh);
    return () => { window.clearTimeout(timer); controller.abort(); window.removeEventListener("focus", refresh); window.removeEventListener("catalog-tags-changed", refresh); };
  }, [enabled, revision, retry]);
  return { data, error, loading, retry };
}
