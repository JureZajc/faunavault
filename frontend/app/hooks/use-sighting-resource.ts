"use client";

import { useEffect, useState } from "react";

export function useSightingResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    load: typeof load;
    attempt: number;
    data?: T;
    error?: string;
  }>();

  useEffect(() => {
    const controller = new AbortController();
    // Resolve inside the promise chain so synchronous transport failures are handled too.
    void Promise.resolve().then(() => load(controller.signal)).then(
      (data) => { if (!controller.signal.aborted) setResult({ load, attempt, data }); },
      (error) => {
        if (!controller.signal.aborted) setResult({
          load, attempt, error: error instanceof Error ? error.message : "Could not load sightings.",
        });
      },
    );
    return () => controller.abort();
  }, [load, attempt]);

  const current = result?.load === load && result.attempt === attempt ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    retry: () => setAttempt((value) => value + 1),
    replace: (data: T) => setResult({ load, attempt, data }),
  };
}
