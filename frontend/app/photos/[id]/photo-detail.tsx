"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import PhotoMedia from "../../components/photo-detail/photo-media";
import PhotoSidebar from "../../components/photo-detail/photo-sidebar";
import { usePhotoClassification } from "../../hooks/use-photo-classification";
import { usePhotoDetail } from "../../hooks/use-photo-detail";
import { Photo } from "../../lib/api";

function safeReturnLocation(returnTo: string | undefined) {
  if (
    !returnTo ||
    !returnTo.startsWith("/") ||
    returnTo.startsWith("//") ||
    returnTo.includes("\\") ||
    /[\u0000-\u001f]/.test(returnTo)
  ) {
    return "/";
  }
  try {
    const origin =
      typeof window === "undefined" ? "http://localhost" : window.location.origin;
    const resolved = new URL(returnTo, origin);
    if (resolved.origin !== origin) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

export default function PhotoDetail({
  id,
  returnTo,
}: {
  id: string;
  returnTo?: string;
}) {
  const router = useRouter();
  const detail = usePhotoDetail(id);
  const [actionError, setActionError] = useState<string | null>(null);
  const classification = usePhotoClassification({
    photoId: Number(id),
    onRefresh: detail.refresh,
    onPhotoUpdated: detail.replacePhoto,
    onError: setActionError,
  });
  const error = actionError ?? detail.error;

  async function handleMoved(photo: Photo) {
    window.sessionStorage.setItem(
      "faunavault.success",
      `Moved ${photo.original_filename} to Trash.`,
    );
    router.push(safeReturnLocation(returnTo));
  }

  return (
    <main className="min-h-screen bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href={safeReturnLocation(returnTo)}
            className="inline-flex w-fit rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 transition hover:border-emerald-300 hover:text-emerald-900"
          >
            Back to catalog
          </Link>
          <p className="break-words text-sm text-stone-500 sm:text-right">
            Field record stored in your local animal archive
          </p>
        </div>

        {error ? (
          <div className="mt-6 break-words rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {detail.isLoading ? (
          <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <div className="aspect-[4/3] animate-pulse rounded-lg bg-stone-200" />
            <div className="h-96 animate-pulse rounded-lg bg-white" />
          </div>
        ) : detail.photo ? (
          <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <PhotoMedia photo={detail.photo} />
            <PhotoSidebar
              photo={detail.photo}
              classification={classification}
              onPhotoUpdated={detail.replacePhoto}
              onError={setActionError}
              onMoved={handleMoved}
            />
          </div>
        ) : (
          <div className="py-20 text-center">
            <h1 className="text-xl font-semibold">Photo not found</h1>
          </div>
        )}
      </div>
    </main>
  );
}
