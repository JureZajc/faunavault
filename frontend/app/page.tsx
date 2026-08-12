"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AlbumBrowser from "./components/album-browser";
import CatalogClassificationPanel from "./components/catalog/catalog-classification-panel";
import CatalogResults from "./components/catalog/catalog-results";
import CatalogToolbar, {
  StatusFilter,
  UNKNOWN_CATEGORY_VALUE,
} from "./components/catalog/catalog-toolbar";
import UploadWorkflow from "./components/catalog/upload-workflow";
import SuccessNotice from "./components/success-notice";
import TrashBrowser from "./components/trash-browser";
import { useCatalogQueryState } from "./hooks/use-catalog-query-state";
import { useCatalogTaxa } from "./hooks/use-catalog-taxa";
import { useClassificationJobs } from "./hooks/use-classification-jobs";
import { usePhotoCatalog } from "./hooks/use-photo-catalog";
import { classifyPendingPhotos, Photo } from "./lib/api";
import {
  catalogSortOption,
  CollectionView,
} from "./lib/catalog-query";

function HomeContent() {
  const query = useCatalogQueryState();
  const {
    data: catalog,
    isLoading,
    error: catalogError,
    refresh: loadPhotos,
  } = usePhotoCatalog(query.catalogState, query.correctPage);
  const taxa = useCatalogTaxa(query.catalogState.taxon_id);
  const taxonOptions = useMemo(() => {
    const options = taxa.selected ? [taxa.selected, ...taxa.items] : taxa.items;
    return Array.from(
      new Map(options.map((option) => [option.taxon_id, option])).values(),
    );
  }, [taxa.items, taxa.selected]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const scheduleCatalogRefresh = useCallback(() => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void loadPhotos().catch(() => undefined);
    }, 200);
  }, [loadPhotos]);
  const {
    jobs: classificationJobs,
    hasActiveJobs: isClassifyingPending,
    error: classificationError,
    acceptEnqueue,
    retry: retryClassification,
  } = useClassificationJobs({ onSucceeded: scheduleCatalogRefresh });

  useEffect(() => {
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const storedNotice = window.sessionStorage.getItem("faunavault.success");
      if (storedNotice) {
        setSuccessNotice(storedNotice);
        window.sessionStorage.removeItem("faunavault.success");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const photos = catalog?.items ?? [];
  const categoryOptions = catalog?.facets.categories.map((item) => item.value) ?? [];
  const catalogStats = catalog?.facets.status_counts ?? {
    pending: 0,
    classified: 0,
    needs_review: 0,
  };
  const hasUnknownCategory = (catalog?.facets.uncategorized_count ?? 0) > 0;
  const pendingPhotoCount = catalogStats.pending;
  const showClassificationPanel =
    pendingPhotoCount > 0 || classificationJobs.length > 0;
  const statusFilter: StatusFilter = query.catalogState.status ?? "all";
  const categoryFilter = query.catalogState.uncategorized
    ? UNKNOWN_CATEGORY_VALUE
    : query.catalogState.category ?? "all";
  const sortOption = catalogSortOption(query.catalogState);
  const hasActiveViewFilters =
    query.searchInput.trim() !== "" ||
    statusFilter !== "all" ||
    categoryFilter !== "all" ||
    query.catalogState.taxon_id !== undefined;
  const error = actionError ?? catalogError;

  async function handleClassifyPending() {
    setActionError(null);
    try {
      acceptEnqueue(await classifyPendingPhotos());
    } catch (nextError) {
      setActionError(
        nextError instanceof Error
          ? nextError.message
          : "Could not queue classification",
      );
    }
  }

  async function handlePhotoMoved(photo: Photo) {
    await loadPhotos();
    setSuccessNotice(`Moved ${photo.original_filename} to Trash.`);
  }

  async function handlePhotoRestored() {
    await loadPhotos();
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <section className="border-b border-stone-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:items-end">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-700">
              Local-first animal archive
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-stone-950 sm:text-5xl">
              FaunaVault
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600">
              A visual catalog for field finds, companion animals, and local AI
              species notes, kept on your Windows machine.
            </p>
            <div className="mt-5 flex flex-wrap gap-3 text-sm text-stone-600">
              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5">
                {catalog?.facets.active_total ?? 0}{" "}
                {(catalog?.facets.active_total ?? 0) === 1 ? "photo" : "photos"}
              </span>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5">
                {categoryOptions.length + (hasUnknownCategory ? 1 : 0)}{" "}
                {categoryOptions.length + (hasUnknownCategory ? 1 : 0) === 1
                  ? "category"
                  : "categories"}
              </span>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-stone-500">
                {catalogStats.pending} pending
              </span>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-stone-500">
                {catalogStats.classified} classified
              </span>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-stone-500">
                {catalogStats.needs_review} needs review
              </span>
            </div>
          </div>
          <UploadWorkflow
            refreshCatalog={loadPhotos}
            onError={setActionError}
            returnTo={query.returnTo}
            onViewTrash={() => query.setCollectionView("trash")}
          />
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-6">
        {successNotice ? (
          <SuccessNotice
            message={successNotice}
            onDismiss={() => setSuccessNotice(null)}
            onViewTrash={() => {
              setSuccessNotice(null);
              query.setCollectionView("trash");
            }}
          />
        ) : null}
        <div className="mb-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-grid min-h-11 grid-cols-3 rounded-lg border border-stone-200 bg-stone-100 p-1">
            {(["list", "album", "trash"] as CollectionView[]).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => query.setCollectionView(view)}
                className={`min-w-28 rounded-md px-4 text-sm font-semibold capitalize transition ${
                  query.collectionView === view
                    ? "bg-white text-emerald-900 shadow-sm"
                    : "text-stone-600 hover:text-stone-900"
                }`}
              >
                {view}
              </button>
            ))}
          </div>
          <p className="text-sm text-stone-500 sm:text-right">
            {query.collectionView === "list"
              ? "Manage individual photo records"
              : query.collectionView === "album"
                ? "Browse the collection by species"
                : "Restore or permanently remove deleted photos"}
          </p>
        </div>

        {query.collectionView === "album" ? (
          <AlbumBrowser />
        ) : query.collectionView === "trash" ? (
          <TrashBrowser
            onNotice={setSuccessNotice}
            onRestored={handlePhotoRestored}
          />
        ) : (
          <>
            <CatalogToolbar
              searchQuery={query.searchInput}
              statusFilter={statusFilter}
              categoryFilter={categoryFilter}
              sortOption={sortOption}
              viewMode={query.catalogState.layout}
              categoryOptions={categoryOptions}
              hasUnknownCategory={hasUnknownCategory}
              taxonId={query.catalogState.taxon_id}
              taxonOptions={taxonOptions}
              taxaLoading={taxa.isLoading}
              taxaError={taxa.error}
              hasMoreTaxa={taxa.hasMore}
              resultCount={photos.length}
              totalCount={catalog?.total ?? 0}
              onSearchChange={query.setSearchInput}
              onStatusChange={(value) =>
                query.setStatus(value === "all" ? undefined : value)
              }
              onCategoryChange={(value) =>
                query.setCategory(
                  value === "all" || value === UNKNOWN_CATEGORY_VALUE
                    ? undefined
                    : value,
                  value === UNKNOWN_CATEGORY_VALUE,
                )
              }
              onSortChange={query.setSort}
              onViewModeChange={query.setLayout}
              onTaxonFocus={() => {
                if (!taxa.isLoaded && !taxa.isLoading) void taxa.load();
              }}
              onTaxonChange={query.setTaxon}
              onLoadMoreTaxa={() => void taxa.loadMore()}
            />

            {showClassificationPanel ? (
              <CatalogClassificationPanel
                pendingPhotoCount={pendingPhotoCount}
                jobs={classificationJobs}
                isClassifying={isClassifyingPending}
                isCatalogLoading={isLoading}
                error={classificationError}
                onClassify={() => void handleClassifyPending()}
                onRetry={retryClassification}
              />
            ) : null}

            <CatalogResults
              catalog={catalog}
              isLoading={isLoading}
              error={error}
              viewMode={query.catalogState.layout}
              hasActiveFilters={hasActiveViewFilters}
              returnTo={query.returnTo}
              onRetry={() => void loadPhotos().catch(() => undefined)}
              onClearFilters={query.clearFilters}
              onPageChange={query.setPage}
              onPhotoMoved={handlePhotoMoved}
              onError={setActionError}
            />
          </>
        )}
      </section>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-[#f7f8f4] p-8">
          <div className="mx-auto h-[32rem] max-w-7xl animate-pulse rounded-lg bg-white" />
        </main>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
