import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import TimelineBrowser from "../app/timeline/timeline-browser";
import {
  timelineMonthHref,
  timelineMonthRange,
} from "../app/lib/photo-timeline";
import { TimelineResponse } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getPhotoTimeline: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));

function timeline(overrides: Partial<TimelineResponse> = {}): TimelineResponse {
  return {
    years: [
      {
        year: 2026,
        photo_count: 5,
        months: [
          {
            month: 8,
            photo_count: 5,
            previews: [
              {
                id: 2,
                thumbnail_filename: "august-2-thumb.jpg",
                original_filename: "august-2.jpg",
                display_title: "Evening fox",
              },
              {
                id: 1,
                thumbnail_filename: "august-1-thumb.jpg",
                original_filename: "august-1.jpg",
                display_title: " ",
              },
            ],
          },
        ],
      },
      {
        year: 2025,
        photo_count: 1,
        months: [
          {
            month: 12,
            photo_count: 1,
            previews: [],
          },
        ],
      },
    ],
    unknown_capture_count: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(
    null,
    "",
    "/timeline?catalog_search=stale&catalog_category=bird",
  );
});

test("computes exact month ranges and isolated List URLs", () => {
  expect(timelineMonthRange(2023, 2)).toEqual({
    takenFrom: "2023-02-01",
    takenTo: "2023-02-28",
  });
  expect(timelineMonthRange(2024, 2)).toEqual({
    takenFrom: "2024-02-01",
    takenTo: "2024-02-29",
  });
  expect(timelineMonthRange(2026, 4)).toEqual({
    takenFrom: "2026-04-01",
    takenTo: "2026-04-30",
  });
  expect(timelineMonthRange(2026, 8)).toEqual({
    takenFrom: "2026-08-01",
    takenTo: "2026-08-31",
  });
  expect(timelineMonthRange(4, 2)).toEqual({
    takenFrom: "0004-02-01",
    takenTo: "0004-02-29",
  });
  expect(timelineMonthHref(2026, 8)).toBe(
    "/?catalog_taken_from=2026-08-01&catalog_taken_to=2026-08-31&catalog_sort=captured_at&catalog_order=desc",
  );
});

test("renders ordered semantic groups, previews, navigation, and unknown count", async () => {
  api.getPhotoTimeline.mockResolvedValue(timeline());
  render(<TimelineBrowser />);

  expect(screen.getByRole("status").textContent).toContain("Loading Timeline");
  expect(await screen.findByRole("heading", { name: "2026" })).toBeTruthy();
  const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
  expect(headings).toEqual(["Timeline", "2026", "August5 photos", "2025", "December1 photo"]);
  expect(screen.getByText("3 photos have no capture date.")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Evening fox" })).toBeTruthy();
  const filenamePreview = screen.getByRole("img", { name: "august-1.jpg" });
  expect(filenamePreview.closest("a")).toBeNull();

  const monthLink = screen.getByRole("link", {
    name: "View 5 photos from August 2026",
  });
  expect(monthLink.getAttribute("href")).toBe(
    "/?catalog_taken_from=2026-08-01&catalog_taken_to=2026-08-31&catalog_sort=captured_at&catalog_order=desc",
  );
  expect(monthLink.getAttribute("href")).not.toContain("stale");

  const navigation = screen.getByRole("navigation", { name: "Archive views" });
  expect(
    Array.from(navigation.querySelectorAll("a")).map((link) => link.textContent),
  ).toEqual(["List", "Timeline", "Map", "Albums", "Collections", "Trash"]);
  expect(screen.getByRole("link", { name: "Timeline" }).getAttribute("aria-current"))
    .toBe("page");
});

test("shows truthful empty and unknown-only states", async () => {
  api.getPhotoTimeline.mockResolvedValueOnce(
    timeline({ years: [], unknown_capture_count: 0 }),
  );
  const first = render(<TimelineBrowser />);
  expect(await screen.findByText("No photos in Timeline yet")).toBeTruthy();
  first.unmount();

  api.getPhotoTimeline.mockResolvedValueOnce(
    timeline({ years: [], unknown_capture_count: 7 }),
  );
  render(<TimelineBrowser />);
  expect(await screen.findByText("No photos with capture dates yet")).toBeTruthy();
  expect(screen.getByText("7 photos have no capture date.")).toBeTruthy();
});

test("shows a safe error and retries", async () => {
  api.getPhotoTimeline
    .mockRejectedValueOnce(new Error("private backend detail"))
    .mockResolvedValueOnce(timeline({ years: [], unknown_capture_count: 0 }));
  render(<TimelineBrowser />);

  expect(await screen.findByText("Could not load the photo timeline")).toBeTruthy();
  expect(screen.queryByText("private backend detail")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(api.getPhotoTimeline).toHaveBeenCalledTimes(2));
  expect(await screen.findByText("No photos in Timeline yet")).toBeTruthy();
});
