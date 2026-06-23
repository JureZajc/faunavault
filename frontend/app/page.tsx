"use client";

import Link from "next/link";
import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  BatchUploadFailure,
  classifyPhoto,
  deletePhoto,
  getPhotos,
  imageUrl,
  Photo,
  PhotoStatus,
  uploadPhotoBatch,
  uploadPhoto,
} from "./lib/api";

type StatusFilter = "all" | PhotoStatus;
type SortOption =
  | "newest"
  | "oldest"
  | "confidence_desc"
  | "confidence_asc";
type UploadNotice = {
  kind: "success" | "warning";
  message: string;
};
type ClassificationProgressStatus =
  | "queued"
  | "running"
  | "classified"
  | "needs_review"
  | "failed";
type ClassificationProgressItem = {
  id: number;
  filename: string;
  status: ClassificationProgressStatus;
  common_name?: string | null;
  species_guess?: string | null;
  error?: string;
};
type ClassificationRunSummary = {
  total_found: number;
  classified: number;
  needs_review: number;
  failed: number;
  results: ClassificationProgressItem[];
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

const sortLabels: Record<SortOption, string> = {
  newest: "Newest",
  oldest: "Oldest",
  confidence_desc: "Confidence high to low",
  confidence_asc: "Confidence low to high",
};

const unknownCategoryValue = "__unknown__";

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

function formatClassifyFailures(result: ClassificationRunSummary) {
  const failedResults = result.results.filter(
    (photoResult) => photoResult.status === "failed",
  );
  const visibleFailures = failedResults
    .slice(0, 3)
    .map(
      (photoResult) =>
        `Photo ${photoResult.id}: ${photoResult.error ?? "Classification failed"}`,
    )
    .join("; ");
  const remainingCount = failedResults.length - Math.min(failedResults.length, 3);

  return remainingCount > 0
    ? `${visibleFailures}; ${remainingCount} more failed`
    : visibleFailures;
}

function formatClassifySummary(result: ClassificationRunSummary) {
  if (result.total_found === 0) {
    return "No pending photos found.";
  }

  const summary = `${result.total_found} pending ${result.total_found === 1 ? "photo" : "photos"} found. ${result.classified} classified, ${result.needs_review} marked needs review, ${result.failed} failed.`;

  return result.failed > 0
    ? `${summary} ${formatClassifyFailures(result)}.`
    : summary;
}

function classificationProgressLabel(status: ClassificationProgressStatus) {
  if (status === "running") {
    return "Classifying";
  }

  if (status === "classified") {
    return "Classified";
  }

  if (status === "needs_review") {
    return "Needs review";
  }

  if (status === "failed") {
    return "Failed";
  }

  return "Queued";
}

function classificationProgressPercent(status: ClassificationProgressStatus) {
  if (status === "queued") {
    return 0;
  }

  if (status === "running") {
    return 55;
  }

  return 100;
}

function normalizeSearchText(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase() ?? "";
}

function photoMatchesSearch(photo: Photo, searchQuery: string) {
  const query = normalizeSearchText(searchQuery);

  if (!query) {
    return true;
  }

  const searchableText = [
    photo.common_name,
    photo.species_guess,
    photo.category,
    photo.description,
    photo.tags.join(" "),
  ]
    .map(normalizeSearchText)
    .join(" ");

  return searchableText.includes(query);
}

function photoMatchesFilters(
  photo: Photo,
  statusFilter: StatusFilter,
  categoryFilter: string,
) {
  const matchesStatus =
    statusFilter === "all" ? true : photo.status === statusFilter;
  const matchesCategory =
    categoryFilter === "all"
      ? true
      : categoryFilter === unknownCategoryValue
        ? !photo.category
        : photo.category === categoryFilter;

  return matchesStatus && matchesCategory;
}

function compareConfidence(
  firstPhoto: Photo,
  secondPhoto: Photo,
  direction: "asc" | "desc",
) {
  const firstConfidence = firstPhoto.confidence;
  const secondConfidence = secondPhoto.confidence;

  if (firstConfidence === null && secondConfidence === null) {
    return 0;
  }

  if (firstConfidence === null) {
    return 1;
  }

  if (secondConfidence === null) {
    return -1;
  }

  return direction === "asc"
    ? firstConfidence - secondConfidence
    : secondConfidence - firstConfidence;
}

function sortPhotos(photos: Photo[], sortOption: SortOption) {
  return [...photos].sort((firstPhoto, secondPhoto) => {
    const newestFirst =
      new Date(secondPhoto.created_at).getTime() -
      new Date(firstPhoto.created_at).getTime();

    if (sortOption === "newest") {
      return newestFirst;
    }

    if (sortOption === "oldest") {
      return -newestFirst;
    }

    const confidenceComparison = compareConfidence(
      firstPhoto,
      secondPhoto,
      sortOption === "confidence_asc" ? "asc" : "desc",
    );

    return confidenceComparison || newestFirst;
  });
}

function getCategoryOptions(photos: Photo[]) {
  return Array.from(
    new Set(
      photos
        .map((photo) => photo.category?.trim())
        .filter((category): category is string => Boolean(category)),
    ),
  ).sort((firstCategory, secondCategory) =>
    firstCategory.localeCompare(secondCategory),
  );
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
  isDeleting,
  onDelete,
}: {
  photo: Photo;
  isDeleting: boolean;
  onDelete: (photo: Photo) => void;
}) {
  const thumbnailUrl = imageUrl("thumbs", photo.thumbnail_filename);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageFailed = failedImageUrl === thumbnailUrl;
  const title = photo.common_name ?? "Unclassified";
  const speciesGuess = photo.species_guess ?? "Species not identified";

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-emerald-300 hover:shadow-md">
      <Link href={`/photos/${photo.id}`} className="block">
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
        <Link href={`/photos/${photo.id}`} className="block flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-stone-950">
                {title}
              </h2>
              <p className="mt-1 truncate text-sm italic text-stone-500">
                {speciesGuess}
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

        <button
          type="button"
          onClick={() => onDelete(photo)}
          disabled={isDeleting}
          className="mt-4 min-h-10 w-full rounded-md border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-700 transition hover:border-red-300 hover:bg-red-100 disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-400"
        >
          {isDeleting ? "Deleting" : "Delete photo"}
        </button>
      </div>
    </article>
  );
}

function CatalogToolbar({
  searchQuery,
  statusFilter,
  categoryFilter,
  sortOption,
  categoryOptions,
  hasUnknownCategory,
  resultCount,
  totalCount,
  onSearchChange,
  onStatusChange,
  onCategoryChange,
  onSortChange,
}: {
  searchQuery: string;
  statusFilter: StatusFilter;
  categoryFilter: string;
  sortOption: SortOption;
  categoryOptions: string[];
  hasUnknownCategory: boolean;
  resultCount: number;
  totalCount: number;
  onSearchChange: (value: string) => void;
  onStatusChange: (value: StatusFilter) => void;
  onCategoryChange: (value: string) => void;
  onSortChange: (value: SortOption) => void;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))]">
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
            {hasUnknownCategory ? (
              <option value={unknownCategoryValue}>Unknown</option>
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

      <div className="mt-4 flex flex-col gap-2 border-t border-stone-100 pt-4 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between">
        <p>
          Showing{" "}
          <span className="font-semibold text-stone-800">{resultCount}</span> of{" "}
          <span className="font-semibold text-stone-800">{totalCount}</span>{" "}
          {totalCount === 1 ? "record" : "records"}
        </p>
        <p>Local collection, filtered in your browser.</p>
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

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortOption, setSortOption] = useState<SortOption>("newest");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [deletingPhotoIds, setDeletingPhotoIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [isClassifyingPending, setIsClassifyingPending] = useState(false);
  const [classificationProgress, setClassificationProgress] = useState<
    ClassificationProgressItem[]
  >([]);
  const [classificationRunSummary, setClassificationRunSummary] =
    useState<ClassificationRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<UploadNotice | null>(null);

  const loadPhotos = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const nextPhotos = await getPhotos();
      setPhotos(nextPhotos);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not load the catalog",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    getPhotos()
      .then((nextPhotos) => {
        if (isMounted) {
          setPhotos(nextPhotos);
        }
      })
      .catch((nextError: Error) => {
        if (isMounted) {
          setError(nextError.message);
        }
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const categoryOptions = useMemo(() => getCategoryOptions(photos), [photos]);
  const hasUnknownCategory = useMemo(
    () => photos.some((photo) => !photo.category?.trim()),
    [photos],
  );
  const pendingPhotoCount = useMemo(
    () => photos.filter((photo) => photo.status === "pending").length,
    [photos],
  );
  const completedClassificationCount = useMemo(
    () =>
      classificationProgress.filter(
        (photoResult) =>
          photoResult.status === "classified" ||
          photoResult.status === "needs_review" ||
          photoResult.status === "failed",
      ).length,
    [classificationProgress],
  );
  const totalClassificationCount = classificationProgress.length;
  const overallClassificationPercent =
    totalClassificationCount === 0
      ? 0
      : Math.round(
          (completedClassificationCount / totalClassificationCount) * 100,
        );
  const showClassificationPanel =
    pendingPhotoCount > 0 || isClassifyingPending || classificationRunSummary;

  const activeCategoryFilter =
    categoryFilter === unknownCategoryValue && !hasUnknownCategory
      ? "all"
      : categoryFilter;

  const visiblePhotos = useMemo(() => {
    const matchingPhotos = photos.filter(
      (photo) =>
        photoMatchesSearch(photo, searchQuery) &&
        photoMatchesFilters(photo, statusFilter, activeCategoryFilter),
    );

    return sortPhotos(matchingPhotos, sortOption);
  }, [activeCategoryFilter, photos, searchQuery, sortOption, statusFilter]);

  const hasActiveViewFilters =
    normalizeSearchText(searchQuery) !== "" ||
    statusFilter !== "all" ||
    activeCategoryFilter !== "all";
  const selectedFileLabel = formatSelectedFiles(selectedFiles);

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
      setError(nextError instanceof Error ? nextError.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleClassifyPending() {
    const pendingPhotos = [...photos]
      .filter((photo) => photo.status === "pending")
      .sort(
        (firstPhoto, secondPhoto) =>
          new Date(firstPhoto.created_at).getTime() -
          new Date(secondPhoto.created_at).getTime(),
      );

    if (pendingPhotos.length === 0) {
      setClassificationProgress([]);
      setClassificationRunSummary({
        total_found: 0,
        classified: 0,
        needs_review: 0,
        failed: 0,
        results: [],
      });
      return;
    }

    const initialProgress = pendingPhotos.map((photo) => ({
      id: photo.id,
      filename: photo.original_filename,
      status: "queued" as const,
    }));
    const results: ClassificationProgressItem[] = [...initialProgress];
    let classified = 0;
    let needsReview = 0;
    let failed = 0;

    setIsClassifyingPending(true);
    setError(null);
    setClassificationRunSummary(null);
    setClassificationProgress(initialProgress);

    try {
      for (const pendingPhoto of pendingPhotos) {
        setClassificationProgress((currentProgress) =>
          currentProgress.map((photoResult) =>
            photoResult.id === pendingPhoto.id
              ? { ...photoResult, status: "running" }
              : photoResult,
          ),
        );

        try {
          const updatedPhoto = await classifyPhoto(pendingPhoto.id);
          const updatedStatus: ClassificationProgressStatus =
            updatedPhoto.status === "pending" ? "failed" : updatedPhoto.status;
          const progressResult: ClassificationProgressItem = {
            id: updatedPhoto.id,
            filename: updatedPhoto.original_filename,
            status: updatedStatus,
            common_name: updatedPhoto.common_name,
            species_guess: updatedPhoto.species_guess,
            error:
              updatedStatus === "failed"
                ? "Classification finished without updating the photo status"
                : undefined,
          };

          if (updatedStatus === "classified") {
            classified += 1;
          } else if (updatedStatus === "needs_review") {
            needsReview += 1;
          } else {
            failed += 1;
          }

          const resultIndex = results.findIndex(
            (photoResult) => photoResult.id === updatedPhoto.id,
          );
          if (resultIndex >= 0) {
            results[resultIndex] = progressResult;
          }

          setPhotos((currentPhotos) =>
            currentPhotos.map((photo) =>
              photo.id === updatedPhoto.id ? updatedPhoto : photo,
            ),
          );
          setClassificationProgress((currentProgress) =>
            currentProgress.map((photoResult) =>
              photoResult.id === updatedPhoto.id ? progressResult : photoResult,
            ),
          );
        } catch (nextError) {
          failed += 1;
          const progressResult: ClassificationProgressItem = {
            id: pendingPhoto.id,
            filename: pendingPhoto.original_filename,
            status: "failed",
            error:
              nextError instanceof Error
                ? nextError.message
                : "Classification failed",
          };
          const resultIndex = results.findIndex(
            (photoResult) => photoResult.id === pendingPhoto.id,
          );
          if (resultIndex >= 0) {
            results[resultIndex] = progressResult;
          }

          setClassificationProgress((currentProgress) =>
            currentProgress.map((photoResult) =>
              photoResult.id === pendingPhoto.id ? progressResult : photoResult,
            ),
          );
        }
      }

      setClassificationRunSummary({
        total_found: pendingPhotos.length,
        classified,
        needs_review: needsReview,
        failed,
        results,
      });

      try {
        const refreshedPhotos = await getPhotos();
        setPhotos(refreshedPhotos);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Could not refresh the catalog",
        );
      }
    } finally {
      setIsClassifyingPending(false);
    }
  }

  async function handleDeletePhoto(photo: Photo) {
    const confirmed = window.confirm(
      `Delete photo "${photo.original_filename}"? This cannot be undone.`,
    );
    if (!confirmed) {
      return;
    }

    setDeletingPhotoIds((currentIds) => new Set(currentIds).add(photo.id));
    setError(null);
    try {
      await deletePhoto(photo.id);
      setPhotos((currentPhotos) =>
        currentPhotos.filter((currentPhoto) => currentPhoto.id !== photo.id),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Delete failed");
    } finally {
      setDeletingPhotoIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(photo.id);
        return nextIds;
      });
    }
  }

  function clearViewFilters() {
    setSearchQuery("");
    setStatusFilter("all");
    setCategoryFilter("all");
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
                {photos.length} {photos.length === 1 ? "photo" : "photos"}
              </span>
              <span className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5">
                {categoryOptions.length}{" "}
                {categoryOptions.length === 1 ? "category" : "categories"}
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
                {uploadNotice.message}
              </div>
            ) : null}
          </form>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-6">
        <CatalogToolbar
          searchQuery={searchQuery}
          statusFilter={statusFilter}
          categoryFilter={activeCategoryFilter}
          sortOption={sortOption}
          categoryOptions={categoryOptions}
          hasUnknownCategory={hasUnknownCategory}
          resultCount={visiblePhotos.length}
          totalCount={photos.length}
          onSearchChange={setSearchQuery}
          onStatusChange={setStatusFilter}
          onCategoryChange={setCategoryFilter}
          onSortChange={setSortOption}
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

          {isClassifyingPending ? (
            <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-800">
              <div className="flex items-center justify-between gap-3">
                <p>
                  Classifying {completedClassificationCount} of{" "}
                  {totalClassificationCount} pending photos.
                </p>
                <span className="font-semibold">
                  {overallClassificationPercent}%
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-sky-100">
                <div
                  className="h-full rounded-full bg-sky-600 transition-all duration-300"
                  style={{ width: `${overallClassificationPercent}%` }}
                />
              </div>
            </div>
          ) : null}

          {classificationProgress.length > 0 ? (
            <div className="mt-3 space-y-2">
              {classificationProgress.map((photoResult) => {
                const progressPercent = classificationProgressPercent(
                  photoResult.status,
                );
                const isRunning = photoResult.status === "running";
                const isFailed = photoResult.status === "failed";
                const isReview = photoResult.status === "needs_review";
                const barColor = isFailed
                  ? "bg-red-500"
                  : isReview
                    ? "bg-amber-500"
                    : "bg-emerald-600";

                return (
                  <div
                    key={photoResult.id}
                    className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2"
                  >
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-stone-900">
                          Photo {photoResult.id}: {photoResult.filename}
                        </p>
                        {photoResult.common_name ||
                        photoResult.species_guess ||
                        photoResult.error ? (
                          <p className="mt-0.5 truncate text-xs text-stone-500">
                            {photoResult.error ??
                              [photoResult.common_name, photoResult.species_guess]
                                .filter(Boolean)
                                .join(" · ")}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className={`text-xs font-semibold ${
                          isFailed
                            ? "text-red-700"
                            : isReview
                              ? "text-amber-700"
                              : "text-stone-600"
                        }`}
                      >
                        {classificationProgressLabel(photoResult.status)}
                      </span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-white">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${barColor} ${
                          isRunning ? "animate-pulse" : ""
                        }`}
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {classificationRunSummary ? (
            <div
              className={`mt-3 rounded-md border px-3 py-2 text-sm ${
                classificationRunSummary.failed > 0
                  ? "border-amber-200 bg-amber-50 text-amber-800"
                  : "border-emerald-200 bg-emerald-50 text-emerald-800"
              }`}
            >
              <p>{formatClassifySummary(classificationRunSummary)}</p>
              {classificationRunSummary.failed > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {classificationRunSummary.results
                    .filter((photoResult) => photoResult.status === "failed")
                    .map((photoResult) => (
                      <li key={photoResult.id}>
                        Photo {photoResult.id}:{" "}
                        {photoResult.error ?? "Classification failed"}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
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

        {isLoading ? (
          <div className="grid gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-[28rem] animate-pulse rounded-lg border border-stone-200 bg-white"
              />
            ))}
          </div>
        ) : photos.length === 0 ? (
          <div className="py-8">
            <CatalogStateMessage
              title="Start your animal archive"
              description="Upload an image to create the first record in this local collection."
            />
          </div>
        ) : visiblePhotos.length > 0 ? (
          <div className="grid items-stretch gap-5 py-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {visiblePhotos.map((photo) => (
              <PhotoCard
                key={photo.id}
                photo={photo}
                isDeleting={deletingPhotoIds.has(photo.id)}
                onDelete={handleDeletePhoto}
              />
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
      </section>
    </main>
  );
}
