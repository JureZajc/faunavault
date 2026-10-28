"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ImageLightbox, { LightboxImage } from "./image-lightbox";
import { getCatalogPhotos, getCollection, getCullingWorkspace, imageUrl, Photo } from "../lib/api";
import { DEFAULT_CATALOG_STATE } from "../lib/catalog-query";

type GalleryPage = { items: Photo[]; total: number; page: number; page_size: number; total_pages: number };
export type GalleryStart = { page: number; index: number; photoId?: number };
type Props = {
  kind: "collection" | "event";
  id: number;
  start: GalleryStart;
  onClose: () => void;
};

const PAGE_SIZE = 48;
const MAX_PAGES = 3;

// A new source always gets a fresh cache, request lifetime, and playback state.
export default function PaginatedPhotoGallery(props: Props) {
  return <GallerySession key={`${props.kind}:${props.id}`} {...props} />;
}

function GallerySession({ kind, id, start, onClose }: Props) {
  const cache = useRef(new Map<number, GalleryPage>());
  const request = useRef<AbortController | null>(null);
  const pending = useRef(0);
  const [state, setState] = useState<{
    photo: Photo | null; index: number; total: number; busy: boolean; error: string | null;
  }>({ photo: null, index: 0, total: 0, busy: true, error: null });
  const query = useMemo(() => ({ ...DEFAULT_CATALOG_STATE, event_id: id }), [id]);

  const load = useCallback(async (target: number, resolveCover = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    pending.current = target;
    setState((value) => ({ ...value, busy: true, error: null }));
    try {
      if (resolveCover && start.photoId !== undefined && kind === "event") {
        // Existing ranked catalog API locates a distant cover in one request.
        const location = await getCullingWorkspace(query, start.photoId, controller.signal);
        target = location.matches_query && location.position ? location.position - 1 : 0;
        if (controller.signal.aborted) return false;
        pending.current = target;
      }
      const page = Math.floor(target / PAGE_SIZE) + 1;
      let result = cache.current.get(page);
      if (!result) {
        result = kind === "collection"
          ? (await getCollection(id, page, PAGE_SIZE, controller.signal)).photos
          : await getCatalogPhotos({ ...query, page, page_size: PAGE_SIZE }, controller.signal);
      }
      if (controller.signal.aborted) return false;
      cache.current.delete(page);
      cache.current.set(page, result);
      while (cache.current.size > MAX_PAGES) cache.current.delete(cache.current.keys().next().value!);
      if (!result.total) {
        setState({ photo: null, index: 0, total: 0, busy: false, error: null });
        return false;
      }
      const offset = target % PAGE_SIZE;
      const photo = result.items[offset];
      if (!photo || photo.deleted_at) {
        throw new Error("This gallery position is no longer available. Retry or navigate to another page.");
      }
      setState({ photo, index: target, total: result.total, busy: false, error: null });
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      // A failed page is never cached, so Retry always revalidates membership.
      cache.current.delete(Math.floor(target / PAGE_SIZE) + 1);
      setState((value) => ({
        ...value, busy: false,
        error: error instanceof Error ? error.message : "Could not load gallery Photos.",
      }));
      return false;
    }
  }, [id, kind, query, start.photoId]);

  useEffect(() => {
    const pages = cache.current;
    const timer = window.setTimeout(() => {
      void load((start.page - 1) * PAGE_SIZE + start.index, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      pages.clear();
    };
  }, [load, start.index, start.page]);

  const images: LightboxImage[] = state.photo ? [{
    imageUrl: imageUrl("resized", state.photo.resized_filename),
    alt: state.photo.display_title || state.photo.common_name || state.photo.original_filename,
    caption: [state.photo.display_title || state.photo.common_name, state.photo.original_filename, state.photo.description].filter(Boolean).join(" · "),
  }] : [];
  const skipTarget = (Math.floor(pending.current / PAGE_SIZE) + 1) * PAGE_SIZE;
  return <ImageLightbox images={images} onClose={onClose} navigation={{
    index: state.index, total: state.total, busy: state.busy, error: state.error,
    onNavigate: (index) => load(index),
    onRetry: () => void load(pending.current, !state.photo && start.photoId !== undefined),
    onSkip: skipTarget < state.total ? () => void load(skipTarget) : undefined,
  }} />;
}
