import { TimelinePhotoPreview } from "./api";

const monthFormatter = new Intl.DateTimeFormat("en", {
  month: "long",
  timeZone: "UTC",
});

function assertTimelineMonth(year: number, month: number) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError("Timeline year must be between 1 and 9999");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("Timeline month must be between 1 and 12");
  }
}

function isoDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function timelineMonthName(month: number) {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError("Timeline month must be between 1 and 12");
  }
  return monthFormatter.format(new Date(Date.UTC(2000, month - 1, 1)));
}

export function timelineMonthRange(year: number, month: number) {
  assertTimelineMonth(year, month);
  const finalDate = new Date(0);
  finalDate.setUTCHours(0, 0, 0, 0);
  finalDate.setUTCFullYear(year, month, 0);
  return {
    takenFrom: isoDate(year, month, 1),
    takenTo: isoDate(year, month, finalDate.getUTCDate()),
  };
}

export function timelineMonthHref(year: number, month: number) {
  const { takenFrom, takenTo } = timelineMonthRange(year, month);
  const params = new URLSearchParams({
    catalog_taken_from: takenFrom,
    catalog_taken_to: takenTo,
    catalog_sort: "captured_at",
    catalog_order: "desc",
  });
  return `/?${params.toString()}`;
}

export function timelinePreviewTitle(preview: TimelinePhotoPreview) {
  return preview.display_title?.trim() || preview.original_filename;
}
