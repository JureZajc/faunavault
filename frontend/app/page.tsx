"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AlbumBrowser from "./components/album-browser";
import ArchiveNavigation from "./components/archive-navigation";
import BulkActionDialog from "./components/catalog/bulk-action-dialog";
import BulkSelectionToolbar, {
  BulkDialogAction,
} from "./components/catalog/bulk-selection-toolbar";
import AddToCollectionDialog from "./components/collections/add-to-collection-dialog";
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
import { useBulkPhotoActions } from "./hooks/use-bulk-photo-actions";
import { useCatalogSelection } from "./hooks/use-catalog-selection";
import { useCatalogTaxa } from "./hooks/use-catalog-taxa";
import { useClassificationJobs } from "./hooks/use-classification-jobs";
import { usePhotoCatalog } from "./hooks/use-photo-catalog";
import {
  BulkPhotoMutationResponse,
  classifyPendingPhotos,
  Photo,
} from "./lib/api";
import { catalogSortOption } from "./lib/catalog-query";

function HomeContent() {
  const query = useCatalogQueryState();
  const selectionContextKey = useMemo(
    () =>
      JSON.stringify({
        view: query.homeView,
        search: query.catalogState.search ?? null,
        status: query.catalogState.status ?? null,
        category: query.catalogState.category ?? null,
        uncategorized: query.catalogState.uncategorized ?? false,
        taxonId: query.catalogState.taxon_id ?? null,
        takenFrom: query.catalogState.taken_from ?? null,
        takenTo: query.catalogState.taken_to ?? null,
        sort: query.catalogState.sort,
        order: query.catalogState.order,
      }),
    [query.catalogState, query.homeView],
  );
  const selection = useCatalogSelection(selectionContextKey);
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
  const [bulkDialog, setBulkDialog] = useState<BulkDialogAction | null>(null);
  const [addCollectionIds, setAddCollectionIds] = useState<number[] | null>(null);
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

  const photos = useMemo(() => catalog?.items ?? [], [catalog?.items]);
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
    query.catalogState.taxon_id !== undefined ||
    query.catalogState.taken_from !== undefined ||
    query.catalogState.taken_to !== undefined;
  const error = actionError ?? catalogError;
  const visiblePhotoIds = useMemo(() => photos.map((photo) => photo.id), [photos]);

  const handleBulkMutationSucceeded = useCallback(
    (response: BulkPhotoMutationResponse) => {
      const actionLabel =
        response.operation === "add_tags"
          ? "Added tags to"
          : response.operation === "remove_tags"
            ? "Removed tags from"
            : response.operation === "set_category"
              ? "Set the category for"
              : response.operation === "clear_category"
                ? "Cleared the category for"
                : "Moved to Trash";
      setBulkDialog(null);
      selection.reset();
      setActionError(null);
      setSuccessNotice(
        response.operation === "move_to_trash"
          ? `Moved ${response.affected_count} ${response.affected_count === 1 ? "photo" : "photos"} to Trash.`
          : `${actionLabel} ${response.affected_count} ${response.affected_count === 1 ? "photo" : "photos"}.`,
      );
    },
    [selection],
  );
  const handleBulkRefreshFailed = useCallback((message: string) => {
    setActionError(message);
  }, []);
  const bulkActions = useBulkPhotoActions({
    selectedIds: selection.selectedIds,
    refreshCatalog: loadPhotos,
    onMutationSucceeded: handleBulkMutationSucceeded,
    onRefreshFailed: handleBulkRefreshFailed,
  });

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
        <div className="mx-auto grid max-w-7xl gap-6 px-3 py-8 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] lg:items-end">
          <div className="min-w-0">
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
            onViewTrash={() => query.setHomeView("trash")}
          />
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-3 py-6 sm:px-6">
        {successNotice ? (
          <SuccessNotice
            message={successNotice}
            onDismiss={() => setSuccessNotice(null)}
            onViewTrash={() => {
              setSuccessNotice(null);
              query.setHomeView("trash");
            }}
          />
        ) : null}
        <div className="mb-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <ArchiveNavigation
            active={query.homeView}
            onNavigate={(section, event) => {
              if (section === "collections") {
                selection.reset();
                return;
              }
              event.preventDefault();
              if (section !== query.homeView) {
                selection.reset();
                query.setHomeView(section);
              }
            }}
          />
          <p className="text-sm text-stone-500 sm:text-right">
            {query.homeView === "list"
              ? "Manage individual photo records"
              : query.homeView === "album"
                ? "Browse the collection by species"
                : "Restore or permanently remove deleted photos"}
          </p>
        </div>

        {query.homeView === "album" ? (
          <AlbumBrowser />
        ) : query.homeView === "trash" ? (
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
              takenFrom={query.catalogState.taken_from}
              takenTo={query.catalogState.taken_to}
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
              hasActiveFilters={hasActiveViewFilters}
              isSelectionMode={selection.isSelecting}
              onSearchChange={(value) => {
                selection.reset();
                query.setSearchInput(value);
              }}
              onStatusChange={(value) => {
                selection.reset();
                query.setStatus(value === "all" ? undefined : value);
              }}
              onCategoryChange={(value) => {
                selection.reset();
                query.setCategory(
                  value === "all" || value === UNKNOWN_CATEGORY_VALUE
                    ? undefined
                    : value,
                  value === UNKNOWN_CATEGORY_VALUE,
                );
              }}
              onTakenFromChange={(value) => {
                selection.reset();
                query.setTakenFrom(value);
              }}
              onTakenToChange={(value) => {
                selection.reset();
                query.setTakenTo(value);
              }}
              onSortChange={(value) => {
                selection.reset();
                query.setSort(value);
              }}
              onViewModeChange={query.setLayout}
              onTaxonFocus={() => {
                if (!taxa.isLoaded && !taxa.isLoading) void taxa.load();
              }}
              onTaxonChange={(value) => {
                selection.reset();
                query.setTaxon(value);
              }}
              onLoadMoreTaxa={() => void taxa.loadMore()}
              onResetFilters={() => {
                selection.reset();
                query.clearFilters();
              }}
              onEnterSelectionMode={selection.enter}
            />

            {selection.isSelecting ? (
              <BulkSelectionToolbar
                selectedIds={selection.selectedIds}
                visibleIds={visiblePhotoIds}
                isBusy={bulkActions.isBusy}
                error={selection.error}
                onTogglePage={selection.togglePage}
                onClear={selection.clear}
                onExit={selection.reset}
                onOpenAction={(action) => {
                  bulkActions.clearError();
                  if (action === "add_to_collection") {
                    setAddCollectionIds(
                      Array.from(selection.selectedIds).sort((a, b) => a - b),
                    );
                  } else {
                    setBulkDialog(action);
                  }
                }}
              />
            ) : null}

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
              onRetry={() => {
                setActionError(null);
                void loadPhotos().catch(() => undefined);
              }}
              onClearFilters={() => {
                selection.reset();
                query.clearFilters();
              }}
              onPageChange={query.setPage}
              onPhotoMoved={handlePhotoMoved}
              onError={setActionError}
              isSelectionMode={selection.isSelecting}
              selectedIds={selection.selectedIds}
              isSelectionBusy={bulkActions.isBusy}
              onToggleSelection={selection.toggle}
            />
            <BulkActionDialog
              key={bulkDialog ?? "bulk-closed"}
              action={bulkDialog}
              selectedCount={selection.selectedCount}
              categoryOptions={categoryOptions}
              isBusy={bulkActions.isBusy}
              error={bulkActions.error}
              onClose={() => {
                if (!bulkActions.isBusy) setBulkDialog(null);
              }}
              onSubmit={bulkActions.execute}
            />
            <AddToCollectionDialog
              key={addCollectionIds?.join("-") ?? "collection-closed"}
              photoIds={addCollectionIds}
              onClose={() => setAddCollectionIds(null)}
              onSuccess={(response) => {
                setAddCollectionIds(null);
                selection.reset();
                const added = `${response.added_count} ${response.added_count === 1 ? "photo" : "photos"}`;
                const present = `${response.already_present_count} ${response.already_present_count === 1 ? "was" : "were"}`;
                setSuccessNotice(
                  response.already_present_count
                    ? `Added ${added} to the Collection; ${present} already present.`
                    : `Added ${added} to the Collection.`,
                );
              }}
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
        <main className="min-h-screen bg-[#f7f8f4] p-4 sm:p-8">
          <div className="mx-auto h-[32rem] max-w-7xl animate-pulse rounded-lg bg-white" />
        </main>
      }
    >
      <HomeContent />
    </Suspense>
  );
}
