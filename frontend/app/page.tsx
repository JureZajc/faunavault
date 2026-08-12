"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ApiError,
  BatchUploadFailure,
  CatalogTaxonOption,
  classifyPendingPhotos,
  imageUrl,
  Photo,
  PhotoStatus,
  uploadPhotoBatch,
  uploadPhoto,
} from "./lib/api";
import {
  applyCatalogSortOption,
  catalogSortOption,
  CatalogLayout,
  CatalogSortOption,
  parseCatalogState,
  writeCatalogState,
} from "./lib/catalog-query";
import AlbumBrowser from "./components/album-browser";
import ClassificationJobsPanel from "./components/classification-jobs-panel";
import MoveToTrashButton from "./components/move-to-trash-button";
import SuccessNotice from "./components/success-notice";
import TrashBrowser from "./components/trash-browser";
import { useClassificationJobs } from "./hooks/use-classification-jobs";
import { useCatalogTaxa } from "./hooks/use-catalog-taxa";
import { usePhotoCatalog } from "./hooks/use-photo-catalog";

type StatusFilter = "all" | PhotoStatus;
type SortOption = CatalogSortOption;
type ViewMode = CatalogLayout;
type CollectionView = "list" | "album" | "trash";
type UploadNotice = {
  kind: "success" | "warning";
  message: string;
  duplicatePhotoId?: number;
  duplicateLocation?: "catalog" | "trash";
};

const statusFilters: StatusFilter[] = [
  "all",
  "pending",
  "classified",
  "needs_review",
];

const statusLabels: Record<StatusFilter, string> = {
  all: "All statuses",
  pending: "Pending",
  classified: "Classified",
  needs_review: "Needs review",
};

const sortLabels: Record<CatalogSortOption, string> = {
  newest: "Newest",
  oldest: "Oldest",
  confidence_desc: "Confidence high to low",
  confidence_asc: "Confidence low to high",
  name_asc: "Name A-Z",
  name_desc: "Name Z-A",
  species_asc: "Species A-Z",
  species_desc: "Species Z-A",
  needs_review_first: "Needs review first",
  pending_first: "Pending first",
};

const unknownCategoryValue = "__unknown__";
const unknownCategoryLabel = "Unknown";
const localeCompareOptions: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatConfidence(value: number | null) {
  return value === null ? "Unscored" : `${Math.round(value * 100)}%`;
}

function formatSelectedFiles(files: File[]) {
  if (files.length === 0) {
    return "Choose JPEG, PNG, or WebP images";
  }

  if (files.length === 1) {
    return files[0].name;
  }

  return `${files.length} files selected`;
}

function formatBatchFailureMessage(failed: BatchUploadFailure[]) {
  const visibleFailures = failed
    .slice(0, 3)
    .map((failure) => `${failure.filename}: ${failure.error}`)
    .join("; ");
  const remainingCount = failed.length - Math.min(failed.length, 3);

  return remainingCount > 0
    ? `${visibleFailures}; ${remainingCount} more failed`
    : visibleFailures;
}

function normalizeSearchText(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function normalizeSortText(value: string | null | undefined) {
  return value?.trim() ?? "";
}

function getPhotoDisplayTitle(photo: Photo) {
  return (
    normalizeSortText(photo.display_title) ||
    normalizeSortText(photo.breed_guess) ||
    normalizeSortText(photo.common_name) ||
    "Unclassified"
  );
}

function formatCommonNameForSubtitle(value: string) {
  const normalizedValue = normalizeSortText(value).toLocaleLowerCase();

  if (!normalizedValue) {
    return "";
  }

  return `${normalizedValue.charAt(0).toLocaleUpperCase()}${normalizedValue.slice(1)}`;
}

function titleMatchesCommonName(title: string, commonName: string | null) {
  return normalizeSearchText(title) === normalizeSearchText(commonName);
}

function getPhotoCardSubtitle(photo: Photo, title: string) {
  const speciesGuess = normalizeSortText(photo.species_guess);
  const commonName = normalizeSortText(photo.common_name);

  if (!speciesGuess) {
    return commonName
      ? formatCommonNameForSubtitle(commonName)
      : "Species not identified";
  }

  if (!commonName || titleMatchesCommonName(title, commonName)) {
    return speciesGuess;
  }

  return `${formatCommonNameForSubtitle(commonName)} · ${speciesGuess}`;
}

function getCategoryLabel(category: string | null) {
  return category?.trim() || unknownCategoryLabel;
}

function groupPhotosByCategory(photos: Photo[]) {
  const groupedPhotos = photos.reduce<Map<string, Photo[]>>((groups, photo) => {
    const categoryLabel = getCategoryLabel(photo.category);
    const categoryPhotos = groups.get(categoryLabel) ?? [];

    categoryPhotos.push(photo);
    groups.set(categoryLabel, categoryPhotos);

    return groups;
  }, new Map());

  return Array.from(groupedPhotos.entries())
    .sort(([firstCategory], [secondCategory]) =>
      firstCategory.localeCompare(secondCategory, "en", localeCompareOptions),
    )
    .map(([category, categoryPhotos]) => ({ category, photos: categoryPhotos }));
}

function StatusBadge({ status }: { status: PhotoStatus }) {
  const className =
    status === "classified"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : status === "needs_review"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-sky-200 bg-sky-50 text-sky-800";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {statusLabels[status]}
    </span>
  );
}

function CategoryBadge({ category }: { category: string | null }) {
  return (
    <span className="inline-flex max-w-full items-center rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-medium capitalize text-stone-700">
      <span className="truncate">{category ?? "Unknown"}</span>
    </span>
  );
}

function TagList({ tags, limit = 3 }: { tags: string[]; limit?: number }) {
  const visibleTags = tags.slice(0, limit);
  const remainingCount = tags.length - visibleTags.length;

  if (tags.length === 0) {
    return <span className="text-xs text-stone-400">No tags yet</span>;
  }

  return (
    <div className="flex min-h-7 flex-wrap gap-1.5">
      {visibleTags.map((tag) => (
        <span
          key={tag}
          className="max-w-[9rem] truncate rounded-full border border-emerald-100 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-800"
        >
          {tag}
        </span>
      ))}
      {remainingCount > 0 ? (
        <span className="rounded-full border border-stone-200 bg-white px-2 py-1 text-xs font-medium text-stone-500">
          +{remainingCount}
        </span>
      ) : null}
    </div>
  );
}

function PhotoCard({
  photo,
  returnTo,
  onMoved,
  onError,
}: {
  photo: Photo;
  returnTo: string;
  onMoved: (photo: Photo) => void;
  onError: (message: string) => void;
}) {
  const thumbnailUrl = imageUrl("thumbs", photo.thumbnail_filename);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageFailed = failedImageUrl === thumbnailUrl;
  const title = getPhotoDisplayTitle(photo);
  const subtitle = getPhotoCardSubtitle(photo, title);

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
      <Link
        href={`/photos/${photo.id}?returnTo=${encodeURIComponent(returnTo)}`}
        className="block"
      >
        <div className="aspect-[4/3] overflow-hidden bg-stone-100">
          {imageFailed ? (
            <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm font-medium text-stone-500">
              Image unavailable
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- Backend localhost images must bypass Next image optimization.
            <img
              src={thumbnailUrl}
              alt={title}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
              onError={() => setFailedImageUrl(thumbnailUrl)}
            />
          )}
        </div>
      </Link>

      <div className="flex flex-1 flex-col p-4">
        <Link
          href={`/photos/${photo.id}?returnTo=${encodeURIComponent(returnTo)}`}
          className="block flex-1"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                title={title}
                className="line-clamp-2 text-base font-semibold leading-6 text-stone-950"
              >
                {title}
              </h2>
              <p
                title={subtitle}
                className="mt-1 line-clamp-2 text-sm italic leading-5 text-stone-500"
              >
                {subtitle}
              </p>
            </div>
            <StatusBadge status={photo.status} />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <CategoryBadge category={photo.category} />
            <span className="inline-flex items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-600">
              {formatConfidence(photo.confidence)}
            </span>
          </div>

          <div className="mt-4">
            <TagList tags={photo.tags} />
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-stone-100 pt-3 text-xs text-stone-500">
            <span>{formatDate(photo.created_at)}</span>
            <span className="truncate">{photo.original_filename}</span>
          </div>
        </Link>
        <div className="mt-3 border-t border-stone-100 pt-3">
          <MoveToTrashButton
            photo={photo}
            onMoved={onMoved}
            onError={onError}
            className="min-h-9 w-full rounded-md border border-stone-200 bg-white px-3 text-xs font-semibold text-stone-600 hover:border-red-200 hover:text-red-700"
          />
        </div>
      </div>
    </article>
  );
}

function CatalogToolbar({
  searchQuery,
  statusFilter,
  categoryFilter,
  sortOption,
  viewMode,
  categoryOptions,
  hasUnknownCategory,
  taxonId,
  taxonOptions,
  taxaLoading,
  taxaError,
  hasMoreTaxa,
  resultCount,
  totalCount,
  onSearchChange,
  onStatusChange,
  onCategoryChange,
  onSortChange,
  onViewModeChange,
  onTaxonFocus,
  onTaxonChange,
  onLoadMoreTaxa,
}: {
  searchQuery: string;
  statusFilter: StatusFilter;
  categoryFilter: string;
  sortOption: SortOption;
  viewMode: ViewMode;
  categoryOptions: string[];
  hasUnknownCategory: boolean;
  taxonId?: number;
  taxonOptions: CatalogTaxonOption[];
  taxaLoading: boolean;
  taxaError: string | null;
  hasMoreTaxa: boolean;
  resultCount: number;
  totalCount: number;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onCategoryChange: (value: string) => void;
  onSortChange: (value: SortOption) => void;
  onViewModeChange: (value: ViewMode) => void;
  onTaxonFocus: () => void;
  onTaxonChange: (value?: number) => void;
  onLoadMoreTaxa: () => void;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Search
          </span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Name, species, category, description, tags"
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition placeholder:text-stone-400 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          />
        </label>

        <div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
              Verified taxon
            </span>
            <select
              value={taxonId ? String(taxonId) : ""}
              onFocus={onTaxonFocus}
              onChange={(event) =>
                onTaxonChange(
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
              className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
            >
              <option value="">All verified taxa</option>
              {taxonOptions.map((taxon) => (
                <option key={taxon.taxon_id} value={taxon.taxon_id}>
                  {taxon.label} ({taxon.count})
                </option>
              ))}
            </select>
          </label>
          {hasMoreTaxa ? (
            <button
              type="button"
              disabled={taxaLoading}
              onClick={onLoadMoreTaxa}
              className="mt-1 text-xs font-semibold text-emerald-800 underline disabled:opacity-50"
            >
              {taxaLoading ? "Loading taxa…" : "Load more taxa"}
            </button>
          ) : taxaError ? (
            <button
              type="button"
              onClick={onTaxonFocus}
              className="mt-1 text-xs font-semibold text-red-700 underline"
            >
              Retry taxa
            </button>
          ) : null}
        </div>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Status
          </span>
          <select
            value={statusFilter}
            onChange={(event) =>
              onStatusChange(event.target.value as StatusFilter)
            }
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          >
            {statusFilters.map((filter) => (
              <option key={filter} value={filter}>
                {statusLabels[filter]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Category
          </span>
          <select
            value={categoryFilter}
            onChange={(event) => onCategoryChange(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          >
            <option value="all">All categories</option>
            {hasUnknownCategory || categoryFilter === unknownCategoryValue ? (
              <option value={unknownCategoryValue}>Unknown</option>
            ) : null}
            {categoryFilter !== "all" &&
            categoryFilter !== unknownCategoryValue &&
            !categoryOptions.includes(categoryFilter) ? (
              <option value={categoryFilter}>{categoryFilter}</option>
            ) : null}
            {categoryOptions.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
            Sort
          </span>
          <select
            value={sortOption}
            onChange={(event) => onSortChange(event.target.value as SortOption)}
            className="mt-2 min-h-11 w-full rounded-md border border-stone-200 bg-stone-50 px-3 text-sm text-stone-950 outline-none transition focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
          >
            {Object.entries(sortLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-col gap-3 border-t border-stone-100 pt-4 text-sm text-stone-500 lg:flex-row lg:items-center lg:justify-between">
        <p>
          Showing{" "}
          <span className="font-semibold text-stone-800">{resultCount}</span> of{" "}
          <span className="font-semibold text-stone-800">{totalCount}</span>{" "}
          {totalCount === 1 ? "record" : "records"}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:justify-end">
          <p>Backend-filtered local collection.</p>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
              View
            </span>
            <div className="grid min-h-9 grid-cols-2 overflow-hidden rounded-md border border-stone-200 bg-stone-50 p-1">
              {[
                ["flat", "Flat grid"],
                ["grouped", "Group by category"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onViewModeChange(value as ViewMode)}
                  className={`min-w-[8.5rem] whitespace-nowrap rounded px-3 text-xs font-semibold transition ${
                    viewMode === value
                      ? "bg-white text-emerald-900 shadow-sm"
                      : "text-stone-600 hover:text-stone-950"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CatalogStateMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-white px-6 py-16 text-center">
      <h2 className="text-xl font-semibold text-stone-900">{title}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-stone-500">
        {description}
      </p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

function HomeContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const paramsString = searchParams.toString();
  const catalogState = useMemo(
    () => parseCatalogState(new URLSearchParams(paramsString)),
    [paramsString],
  );
  const collectionView: CollectionView =
    searchParams.get("view") === "album"
      ? "album"
      : searchParams.get("view") === "trash"
        ? "trash"
        : "list";
  const updateCatalog = useCallback(
    (nextState: typeof catalogState, replace = false) => {
      const params = writeCatalogState(
        new URLSearchParams(paramsString),
        nextState,
      );
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      if (replace) router.replace(href, { scroll: false });
      else router.push(href, { scroll: false });
    },
    [paramsString, pathname, router],
  );
  const correctPage = useCallback(
    (page: number) => updateCatalog({ ...catalogState, page }, true),
    [catalogState, updateCatalog],
  );
  const {
    data: catalog,
    isLoading,
    error: catalogError,
    refresh: loadPhotos,
  } = usePhotoCatalog(catalogState, correctPage);
  const taxa = useCatalogTaxa(catalogState.taxon_id);
  const taxonOptions = useMemo(() => {
    const options = taxa.selected ? [taxa.selected, ...taxa.items] : taxa.items;
    return Array.from(
      new Map(options.map((option) => [option.taxon_id, option])).values(),
    );
  }, [taxa.items, taxa.selected]);
  const [searchQuery, setSearchQuery] = useState(catalogState.search ?? "");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const searchTimer = useRef<number | null>(null);
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
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearchQuery(catalogState.search ?? ""),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [catalogState.search]);

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
  const statusFilter: StatusFilter = catalogState.status ?? "all";
  const categoryFilter = catalogState.uncategorized
    ? unknownCategoryValue
    : catalogState.category ?? "all";
  const sortOption = catalogSortOption(catalogState);
  const viewMode = catalogState.layout;
  const visiblePhotos = photos;
  const groupedVisiblePhotos = useMemo(
    () => groupPhotosByCategory(visiblePhotos),
    [visiblePhotos],
  );

  const hasActiveViewFilters =
    normalizeSearchText(searchQuery) !== "" ||
    statusFilter !== "all" ||
    categoryFilter !== "all" ||
    catalogState.taxon_id !== undefined;
  const error = actionError ?? catalogError;
  const returnTo = paramsString ? `${pathname}?${paramsString}` : pathname;
  const selectedFileLabel = formatSelectedFiles(selectedFiles);

  function handleSearchChange(value: string) {
    setSearchQuery(value);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      updateCatalog(
        { ...catalogState, search: value.trim() || undefined, page: 1 },
        true,
      );
    }, 300);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setSelectedFiles(Array.from(event.target.files ?? []));
    setUploadNotice(null);
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;

    if (selectedFiles.length === 0) {
      return;
    }

    setIsUploading(true);
    setError(null);
    setUploadNotice(null);
    try {
      if (selectedFiles.length === 1) {
        await uploadPhoto(selectedFiles[0]);
        await loadPhotos();
        setUploadNotice({ kind: "success", message: "Uploaded 1 photo." });
      } else {
        const result = await uploadPhotoBatch(selectedFiles);

        if (result.uploaded.length > 0) {
          await loadPhotos();
        }

        if (result.failed.length > 0 && result.uploaded.length > 0) {
          setUploadNotice({
            kind: "warning",
            message: `Uploaded ${result.uploaded.length} ${result.uploaded.length === 1 ? "photo" : "photos"}. ${result.failed.length} failed: ${formatBatchFailureMessage(result.failed)}.`,
          });
        } else if (result.failed.length > 0) {
          setError(
            `Upload failed for ${result.failed.length} ${result.failed.length === 1 ? "file" : "files"}: ${formatBatchFailureMessage(result.failed)}.`,
          );
        } else {
          setUploadNotice({
            kind: "success",
            message: `Uploaded ${result.uploaded.length} photos.`,
          });
        }
      }

      setSelectedFiles([]);
      form.reset();
    } catch (nextError) {
      if (
        nextError instanceof ApiError &&
        nextError.details.code === "duplicate_photo"
      ) {
        setUploadNotice({
          kind: "warning",
          message: nextError.message,
          duplicatePhotoId: nextError.details.photo_id,
          duplicateLocation: nextError.details.location,
        });
      } else {
        setError(nextError instanceof Error ? nextError.message : "Upload failed");
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleClassifyPending() {
    setError(null);
    try {
      acceptEnqueue(await classifyPendingPhotos());
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Could not queue classification",
      );
    }
  }

  function clearViewFilters() {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    setSearchQuery("");
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

  function changeCollectionView(view: CollectionView) {
    const params = new URLSearchParams(paramsString);
    if (view !== "list") {
      params.set("view", view);
    } else {
      params.delete("view");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
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

          <form
            onSubmit={handleUpload}
            className="rounded-lg border border-stone-200 bg-stone-50 p-4 shadow-sm"
          >
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-[0.14em] text-stone-500">
                Add to collection
              </span>
              <span className="mt-2 flex min-h-12 cursor-pointer items-center rounded-md border border-dashed border-stone-300 bg-white px-3 text-sm text-stone-600 transition hover:border-emerald-500">
                <input
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  multiple
                  className="sr-only"
                />
                <span className="truncate">
                  {selectedFileLabel}
                </span>
              </span>
            </label>
            {selectedFiles.length > 0 ? (
              <p className="mt-2 text-xs text-stone-500">
                {selectedFiles.length}{" "}
                {selectedFiles.length === 1 ? "file" : "files"} ready to
                upload.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={selectedFiles.length === 0 || isUploading}
              className="mt-3 min-h-11 w-full rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {isUploading
                ? `Uploading ${selectedFiles.length} ${selectedFiles.length === 1 ? "photo" : "photos"}`
                : selectedFiles.length > 1
                  ? "Upload photos"
                  : "Upload photo"}
            </button>
            {uploadNotice ? (
              <div
                className={`mt-3 rounded-md border px-3 py-2 text-sm ${
                  uploadNotice.kind === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-800"
                    : "border-emerald-200 bg-emerald-50 text-emerald-800"
                }`}
              >
                <p>{uploadNotice.message}</p>
                {uploadNotice.duplicateLocation === "catalog" &&
                uploadNotice.duplicatePhotoId ? (
                  <Link
                    href={`/photos/${uploadNotice.duplicatePhotoId}?returnTo=${encodeURIComponent(returnTo)}`}
                    className="mt-2 inline-block font-semibold underline"
                  >
                    View existing photo
                  </Link>
                ) : uploadNotice.duplicateLocation === "trash" ? (
                  <button
                    type="button"
                    onClick={() => changeCollectionView("trash")}
                    className="mt-2 font-semibold underline"
                  >
                    View Trash
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-6">
        {successNotice ? (
          <SuccessNotice
            message={successNotice}
            onDismiss={() => setSuccessNotice(null)}
            onViewTrash={() => {
              setSuccessNotice(null);
              changeCollectionView("trash");
            }}
          />
        ) : null}
        <div className="mb-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-grid min-h-11 grid-cols-3 rounded-lg border border-stone-200 bg-stone-100 p-1">
            {(["list", "album", "trash"] as CollectionView[]).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => changeCollectionView(view)}
                className={`min-w-28 rounded-md px-4 text-sm font-semibold capitalize transition ${
                  collectionView === view
                    ? "bg-white text-emerald-900 shadow-sm"
                    : "text-stone-600 hover:text-stone-900"
                }`}
              >
                {view}
              </button>
            ))}
          </div>
          <p className="text-sm text-stone-500 sm:text-right">
            {collectionView === "list"
              ? "Manage individual photo records"
              : collectionView === "album"
                ? "Browse the collection by species"
                : "Restore or permanently remove deleted photos"}
          </p>
        </div>

        {collectionView === "album" ? (
          <AlbumBrowser />
        ) : collectionView === "trash" ? (
          <TrashBrowser
            onNotice={setSuccessNotice}
            onRestored={handlePhotoRestored}
          />
        ) : (
          <>
        <CatalogToolbar
          searchQuery={searchQuery}
          statusFilter={statusFilter}
          categoryFilter={categoryFilter}
          sortOption={sortOption}
          viewMode={viewMode}
          categoryOptions={categoryOptions}
          hasUnknownCategory={hasUnknownCategory}
          taxonId={catalogState.taxon_id}
          taxonOptions={taxonOptions}
          taxaLoading={taxa.isLoading}
          taxaError={taxa.error}
          hasMoreTaxa={taxa.hasMore}
          resultCount={visiblePhotos.length}
          totalCount={catalog?.total ?? 0}
          onSearchChange={handleSearchChange}
          onStatusChange={(value) =>
            updateCatalog({
              ...catalogState,
              status: value === "all" ? undefined : value,
              page: 1,
            })
          }
          onCategoryChange={(value) =>
            updateCatalog({
              ...catalogState,
              category:
                value === "all" || value === unknownCategoryValue
                  ? undefined
                  : value,
              uncategorized:
                value === unknownCategoryValue ? true : undefined,
              page: 1,
            })
          }
          onSortChange={(value) =>
            updateCatalog(applyCatalogSortOption(catalogState, value))
          }
          onViewModeChange={(value) =>
            updateCatalog({ ...catalogState, layout: value })
          }
          onTaxonFocus={() => {
            if (!taxa.isLoaded && !taxa.isLoading) void taxa.load();
          }}
          onTaxonChange={(value) =>
            updateCatalog({ ...catalogState, taxon_id: value, page: 1 })
          }
          onLoadMoreTaxa={() => void taxa.loadMore()}
        />

        {showClassificationPanel ? (
        <div className="mt-4 rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-stone-900">
                {pendingPhotoCount} pending{" "}
                {pendingPhotoCount === 1 ? "photo" : "photos"}
              </p>
              <p className="mt-1 text-sm text-stone-500">
                Run local AI classification for pending catalog records.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleClassifyPending()}
              disabled={
                pendingPhotoCount === 0 || isClassifyingPending || isLoading
              }
              className="min-h-11 rounded-md bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {isClassifyingPending
                ? "Classifying pending photos"
                : "Classify pending photos"}
            </button>
          </div>

          {classificationError ? (
            <p role="alert" className="mt-3 text-sm text-red-700">
              {classificationError}
            </p>
          ) : null}
          <ClassificationJobsPanel
            jobs={classificationJobs}
            onRetry={retryClassification}
          />
        </div>
        ) : null}

        {error ? (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => void loadPhotos()}
                disabled={isLoading}
                className="min-h-9 rounded-md border border-red-200 bg-white px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {error ? null : isLoading ? (
          <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-[28rem] animate-pulse rounded-lg border border-stone-200 bg-white"
              />
            ))}
          </div>
        ) : (catalog?.facets.active_total ?? 0) === 0 ? (
          <div className="py-8">
            <CatalogStateMessage
              title="Start your animal archive"
              description="Upload an image to create the first record in this local collection."
            />
          </div>
        ) : visiblePhotos.length > 0 && viewMode === "flat" ? (
          <div className="grid items-stretch gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {visiblePhotos.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                returnTo={returnTo}
                onMoved={handlePhotoMoved}
                onError={setError}
              />
            ))}
          </div>
        ) : visiblePhotos.length > 0 ? (
          <div className="space-y-8 py-8">
            {groupedVisiblePhotos.map((group) => (
              <section key={group.category}>
                <div className="mb-3 flex items-center justify-between gap-3 border-b border-stone-200 pb-2">
                  <h2 className="text-lg font-semibold text-stone-950">
                    {group.category}
                  </h2>
                  <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-500">
                    {group.photos.length}{" "}
                    {group.photos.length === 1 ? "record" : "records"}
                  </span>
                </div>
                <div className="grid items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {group.photos.map((photo) => (
                    <PhotoCard
                      key={photo.id}
                      photo={photo}
                      returnTo={returnTo}
                      onMoved={handlePhotoMoved}
                      onError={setError}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="py-8">
            <CatalogStateMessage
              title="No matching records"
              description="Try a broader search, switch category or status, or clear the current catalog filters."
              action={
                hasActiveViewFilters ? (
                  <button
                    type="button"
                    onClick={clearViewFilters}
                    className="min-h-10 rounded-md border border-emerald-700 bg-white px-4 text-sm font-semibold text-emerald-900 transition hover:bg-emerald-50"
                  >
                    Clear filters
                  </button>
                ) : null
              }
            />
          </div>
        )}
        {!error && catalog && catalog.total_pages > 1 ? (
          <nav
            aria-label="Catalog pagination"
            className="flex items-center justify-center gap-3 pb-10"
          >
            <button
              type="button"
              disabled={catalog.page === 1 || isLoading}
              onClick={() =>
                updateCatalog({ ...catalogState, page: catalog.page - 1 })
              }
              className="min-h-10 rounded-md border border-stone-200 bg-white px-4 text-sm font-semibold disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-sm text-stone-600" aria-live="polite">
              Page {catalog.page} of {catalog.total_pages}
            </span>
            <button
              type="button"
              disabled={catalog.page >= catalog.total_pages || isLoading}
              onClick={() =>
                updateCatalog({ ...catalogState, page: catalog.page + 1 })
              }
              className="min-h-10 rounded-md border border-stone-200 bg-white px-4 text-sm font-semibold disabled:opacity-40"
            >
              Next
            </button>
          </nav>
        ) : null}
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
