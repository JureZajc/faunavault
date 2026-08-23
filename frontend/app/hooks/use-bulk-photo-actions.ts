"use client";

import { useCallback, useState } from "react";
import {
  bulkUpdatePhotos,
  BulkPhotoActionRequest,
  BulkPhotoMutationResponse,
} from "../lib/api";

type BulkPhotoActionsOptions = {
  selectedIds: ReadonlySet<number>;
  refreshCatalog: () => Promise<unknown>;
  onMutationSucceeded: (response: BulkPhotoMutationResponse) => void;
  onRefreshFailed: (message: string) => void;
};

export function useBulkPhotoActions({
  selectedIds,
  refreshCatalog,
  onMutationSucceeded,
  onRefreshFailed,
}: BulkPhotoActionsOptions) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  const execute = useCallback(
    async (action: BulkPhotoActionRequest) => {
      if (isBusy || selectedIds.size === 0) return false;
      const photoIds = Array.from(selectedIds).sort((first, second) => first - second);
      setIsBusy(true);
      setError(null);
      let response: BulkPhotoMutationResponse;
      try {
        response = await bulkUpdatePhotos({ ...action, photo_ids: photoIds });
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Could not complete the bulk photo action",
        );
        setIsBusy(false);
        return false;
      }

      onMutationSucceeded(response);
      try {
        await refreshCatalog();
      } catch (nextError) {
        const detail = nextError instanceof Error ? `: ${nextError.message}` : ".";
        onRefreshFailed(`The action succeeded, but the catalog could not refresh${detail}`);
      } finally {
        setIsBusy(false);
      }
      return true;
    },
    [
      isBusy,
      onMutationSucceeded,
      onRefreshFailed,
      refreshCatalog,
      selectedIds,
    ],
  );

  return { execute, isBusy, error, clearError };
}
