"use client";

import Link from "next/link";
import { useState } from "react";
import ArchiveNavigation from "../components/archive-navigation";
import { usePhotoTimeline } from "../hooks/use-photo-timeline";
import {
  imageUrl,
  TimelineMonth,
  TimelinePhotoPreview,
  TimelineYear,
} from "../lib/api";
import {
  timelineMonthHref,
  timelineMonthName,
  timelinePreviewTitle,
} from "../lib/photo-timeline";

function TimelinePreview({ preview }: { preview: TimelinePhotoPreview }) {
  const [failed, setFailed] = useState(false);
  const title = timelinePreviewTitle(preview);

  return (
    <div className="aspect-[4/3] min-w-0 overflow-hidden rounded-md bg-stone-100">
      {failed ? (
        <div className="grid h-full place-items-center px-2 text-center text-xs font-medium text-stone-500">
          Image unavailable
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- Local backend thumbnails bypass Next image optimization.
        <img
          src={imageUrl("thumbs", preview.thumbnail_filename)}
          alt={title}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function TimelineMonthCard({ year, month }: { year: number; month: TimelineMonth }) {
  const name = timelineMonthName(month.month);
  const photoLabel = month.photo_count === 1 ? "photo" : "photos";

  return (
    <article className="min-w-0 rounded-xl border border-stone-200 bg-white p-4 shadow-sm sm:p-5">
      <h3>
        <Link
          href={timelineMonthHref(year, month.month)}
          aria-label={`View ${month.photo_count} ${photoLabel} from ${name} ${year}`}
          className="flex min-h-11 min-w-0 flex-col justify-center gap-1 rounded-md text-stone-950 transition hover:text-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 sm:flex-row sm:items-center sm:justify-between"
        >
          <span className="text-xl font-semibold">{name}</span>
          <span className="text-sm font-medium text-stone-500">
            {month.photo_count} {photoLabel}
          </span>
        </Link>
      </h3>
      <div className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
        {month.previews.map((preview) => (
          <TimelinePreview key={preview.id} preview={preview} />
        ))}
      </div>
    </article>
  );
}

function TimelineYearSection({ year }: { year: TimelineYear }) {
  return (
    <section aria-labelledby={`timeline-year-${year.year}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={`timeline-year-${year.year}`} className="text-2xl font-semibold">
          {year.year}
        </h2>
        <p className="text-sm text-stone-500">
          {year.photo_count} {year.photo_count === 1 ? "photo" : "photos"}
        </p>
      </div>
      <div className="mt-4 grid gap-4">
        {year.months.map((month) => (
          <TimelineMonthCard key={month.month} year={year.year} month={month} />
        ))}
      </div>
    </section>
  );
}

export default function TimelineBrowser() {
  const timeline = usePhotoTimeline();
  const hasKnownCaptures = Boolean(timeline.data?.years.length);
  const unknownCount = timeline.data?.unknown_capture_count ?? 0;

  return (
    <main className="min-h-screen min-w-0 overflow-x-hidden bg-[#f7f8f4] text-stone-950">
      <div className="mx-auto max-w-7xl px-3 py-8 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <ArchiveNavigation active="timeline" />
          <p className="text-sm text-stone-500 lg:text-right">
            Browse active photos by capture date
          </p>
        </div>

        <header className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Archive chronology
          </p>
          <h1 className="mt-2 text-3xl font-semibold">Timeline</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-600">
            Browse your archive by when each photo was taken. Choose a month to
            open its complete, filtered List.
          </p>
        </header>

        {timeline.isLoading ? (
          <div role="status" className="mt-6 space-y-4">
            <p className="text-sm text-stone-500">Loading Timeline…</p>
            <div className="h-44 animate-pulse rounded-xl bg-white" />
            <div className="h-44 animate-pulse rounded-xl bg-white" />
          </div>
        ) : timeline.error ? (
          <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 p-5 text-sm text-red-700">
            <p>{timeline.error}</p>
            <button
              type="button"
              onClick={() => void timeline.retry()}
              className="mt-3 min-h-11 rounded-md border border-red-200 bg-white px-4 font-semibold"
            >
              Retry
            </button>
          </div>
        ) : hasKnownCaptures ? (
          <div className="mt-8 space-y-10">
            {timeline.data!.years.map((year) => (
              <TimelineYearSection key={year.year} year={year} />
            ))}
            {unknownCount > 0 ? (
              <p className="rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm text-stone-600">
                {unknownCount} {unknownCount === 1 ? "photo has" : "photos have"} no
                capture date.
              </p>
            ) : null}
          </div>
        ) : unknownCount > 0 ? (
          <div className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white px-4 py-16 text-center">
            <h2 className="text-xl font-semibold">No photos with capture dates yet</h2>
            <p className="mt-2 text-sm text-stone-500">
              {unknownCount} {unknownCount === 1 ? "photo has" : "photos have"} no
              capture date.
            </p>
          </div>
        ) : (
          <div className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white px-4 py-16 text-center">
            <h2 className="text-xl font-semibold">No photos in Timeline yet</h2>
            <p className="mt-2 text-sm text-stone-500">
              Photos with capture dates will appear here automatically.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
