"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyCatalogSortOption,
  CatalogLayout,
  CatalogSortOption,
  CollectionView,
  parseCatalogState,
  parseCollectionView,
  writeCatalogState,
  writeCollectionView,
} from "../lib/catalog-query";
import { PhotoStatus } from "../lib/api";

export function useCatalogQueryState() {
  const router = useRouter();
  const routerRef = useRef(router);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const paramsString = searchParams.toString();
  const catalogState = useMemo(
    () => parseCatalogState(new URLSearchParams(paramsString)),
    [paramsString],
  );
  const collectionView = useMemo(
    () => parseCollectionView(new URLSearchParams(paramsString)),
    [paramsString],
  );
  const [searchInput, setSearchInputState] = useState(catalogState.search ?? "");
  const searchTimer = useRef<number | null>(null);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  const navigate = useCallback(
    (params: URLSearchParams, replace = false) => {
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      if (replace) routerRef.current.replace(href, { scroll: false });
      else routerRef.current.push(href, { scroll: false });
    },
    [pathname],
  );

  const updateCatalog = useCallback(
    (nextState: typeof catalogState, replace = false) => {
      navigate(
        writeCatalogState(new URLSearchParams(paramsString), nextState),
        replace,
      );
    },
    [navigate, paramsString],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchInputState(catalogState.search ?? ""),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [catalogState.search]);

  useEffect(() => {
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, []);

  function setSearchInput(value: string) {
    setSearchInputState(value);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      updateCatalog(
        { ...catalogState, search: value.trim() || undefined, page: 1 },
        true,
      );
    }, 300);
  }

  function setStatus(status?: PhotoStatus) {
    updateCatalog({ ...catalogState, status, page: 1 });
  }

  function setCategory(category?: string, uncategorized?: boolean) {
    updateCatalog({
      ...catalogState,
      category,
      uncategorized: uncategorized || undefined,
      page: 1,
    });
  }

  function setSort(option: CatalogSortOption) {
    updateCatalog(applyCatalogSortOption(catalogState, option));
  }

  function setLayout(layout: CatalogLayout) {
    updateCatalog({ ...catalogState, layout });
  }

  function setTaxon(taxonId?: number) {
    updateCatalog({ ...catalogState, taxon_id: taxonId, page: 1 });
  }

  function setPage(page: number) {
    updateCatalog({ ...catalogState, page });
  }

  const correctPage = useCallback(
    (page: number) => updateCatalog({ ...catalogState, page }, true),
    [catalogState, updateCatalog],
  );

  function clearFilters() {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = null;
    setSearchInputState("");
    updateCatalog(
      {
        ...catalogState,
        page: 1,
        search: undefined,
        status: undefined,
        category: undefined,
        uncategorized: undefined,
        taxon_id: undefined,
      },
      true,
    );
  }

  function setCollectionView(view: CollectionView) {
    navigate(
      writeCollectionView(new URLSearchParams(paramsString), view),
      false,
    );
  }

  return {
    catalogState,
    collectionView,
    searchInput,
    paramsString,
    returnTo: paramsString ? `${pathname}?${paramsString}` : pathname,
    setSearchInput,
    setStatus,
    setCategory,
    setSort,
    setLayout,
    setTaxon,
    setPage,
    correctPage,
    clearFilters,
    setCollectionView,
  };
}
