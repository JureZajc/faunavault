import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import TimelineBrowser from "../app/timeline/timeline-browser";
import { CalendarResponse } from "../app/lib/api";
import { calendarDayHref, calendarDayLabel, calendarIntensity, calendarMonth, mostActiveDay } from "../app/lib/photo-calendar";

const api = vi.hoisted(() => ({ getPhotoCalendar: vi.fn(), getPhotoTimeline: vi.fn() }));
vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()), ...api,
}));

function calendar(year = 2024, overrides: Partial<CalendarResponse> = {}): CalendarResponse {
  return { year, available_years: [2024, 2025, 2026], photo_count: 7, active_days: 2, max_daily_count: 6,
    days: [{ date: `${year}-02-29`, photo_count: 6 }, { date: `${year}-03-01`, photo_count: 1 }], unknown_capture_count: 3, ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "/timeline?view=calendar&year=2024");
  api.getPhotoTimeline.mockResolvedValue({ years: [], unknown_capture_count: 0 });
  api.getPhotoCalendar.mockResolvedValue(calendar());
});

test("generates real Gregorian months Monday-first, including early and century years", () => {
  expect(calendarMonth(2024, 2).days).toHaveLength(29);
  expect(calendarMonth(2023, 2).days).toHaveLength(28);
  expect(calendarMonth(1900, 2).days).toHaveLength(28);
  expect(calendarMonth(2000, 2).days).toHaveLength(29);
  expect(calendarMonth(4, 2).days.at(-1)).toBe("0004-02-29");
  expect(calendarMonth(99, 12).days.at(-1)).toBe("0099-12-31");
  expect(calendarMonth(9999, 12).days.at(-1)).toBe("9999-12-31");
  expect(calendarMonth(2026, 6).offset).toBe(0); // Monday
  expect(calendarMonth(2024, 2).offset).toBe(3); // Thursday
  expect(calendarMonth(1, 1).offset).toBe(0);
  expect(() => calendarMonth(0, 2)).toThrow(RangeError);
  expect(calendarDayLabel("0004-02-29", 1)).toBe("29 February 4: 1 photo");
  expect(calendarDayHref("2026-05-12")).toBe("/?catalog_taken_from=2026-05-12&catalog_taken_to=2026-05-12&catalog_sort=captured_at");
});

test("uses explicit intensity levels without exaggerating sparse years and resolves ties chronologically", () => {
  expect([0, 1, 3, 6].map((count) => calendarIntensity(count, 6))).toEqual([0, 1, 2, 3]);
  expect(calendarIntensity(1, 1)).toBe(1);
  expect(calendarIntensity(2, 2)).toBe(2);
  expect(mostActiveDay([{ date: "2024-03-01", photo_count: 6 }, { date: "2024-02-29", photo_count: 6 }])?.date).toBe("2024-02-29");
  expect(mostActiveDay([])).toBeNull();
});

test("renders all months, accessible day activity, summary, Metadata Health and exact List drill-down", async () => {
  render(<TimelineBrowser />);
  expect(await screen.findByRole("region", { name: "Daily photography calendar 2024" })).toBeTruthy();
  expect(api.getPhotoTimeline).not.toHaveBeenCalled();
  const overview = screen.getByRole("region", { name: "Daily photography calendar 2024" });
  expect(within(overview).getAllByRole("heading", { level: 3 })).toHaveLength(12);
  const february = screen.getByRole("region", { name: "February 2024" });
  expect(Array.from(february.querySelectorAll("abbr")).map((el) => el.title)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  const day = screen.getByRole("link", { name: "29 February 2024: 6 photos" });
  expect(day.getAttribute("data-activity")).toBe("3");
  expect(day.getAttribute("href")).toBe(calendarDayHref("2024-02-29"));
  expect(screen.getByText("28 February 2024: 0 photos").closest("a")).toBeNull();
  expect(screen.getByRole("link", { name: "Most active day: 29 February 2024: 6 photos" }).getAttribute("href")).toBe(calendarDayHref("2024-02-29"));
  const summary = screen.getByLabelText("Photography activity summary");
  expect(within(summary).getByText("7")).toBeTruthy();
  expect(within(summary).getByText("2")).toBeTruthy();
  expect(within(summary).getByText("3.5")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Metadata Health" }).getAttribute("href")).toBe("/metadata-health");
  expect(screen.getByText(/3 undated photos/)).toBeTruthy();
  day.focus();
  expect(document.activeElement).toBe(day);
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "1 March 2024: 1 photo" }));
});

test("loads only the selected mode, persists years across toggles, reload and browser history", async () => {
  api.getPhotoCalendar.mockImplementation((year?: number) => Promise.resolve(calendar(year ?? 2024, { days: [] })));
  window.history.replaceState(null, "", "/timeline");
  render(<TimelineBrowser />);
  await screen.findByText("No photos in Timeline yet");
  expect(api.getPhotoCalendar).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Calendar" }));
  await screen.findByRole("region", { name: "February 2024" });
  await waitFor(() => expect(window.location.search).toBe("?view=calendar&year=2024"));
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2026");
  await screen.findByRole("region", { name: "February 2026" });
  expect(window.location.search).toBe("?view=calendar&year=2026");
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(screen.getByLabelText("Capture year")).toHaveProperty("value", "2024"));
  await screen.findByRole("region", { name: "February 2024" });
  await act(async () => { window.history.forward(); });
  await waitFor(() => expect(screen.getByLabelText("Capture year")).toHaveProperty("value", "2026"));
  await screen.findByRole("region", { name: "February 2026" });
  await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
  expect(window.location.search).toBe("?year=2026");
  await userEvent.click(screen.getByRole("button", { name: "Calendar" }));
  expect(window.location.search).toBe("?year=2026&view=calendar");
  expect(screen.getByRole("button", { name: "Calendar" }).getAttribute("aria-pressed")).toBe("true");
});

test("restores calendar mode from URL and gracefully replaces invalid year with backend default", async () => {
  window.history.replaceState(null, "", "/timeline?view=calendar&year=10000");
  render(<TimelineBrowser />);
  expect(screen.getByText(/Invalid year in URL/)).toBeTruthy();
  await waitFor(() => expect(window.location.search).toBe("?view=calendar&year=2024"));
  expect(api.getPhotoCalendar.mock.calls[0][0]).toBeUndefined();
});

test.each([0, 4])("handles empty and undated-only archives without inventing a year (%s undated)", async (unknown) => {
  api.getPhotoCalendar.mockResolvedValue(calendar(2024, { year: null, available_years: [], days: [], photo_count: 0, active_days: 0, max_daily_count: 0, unknown_capture_count: unknown }));
  window.history.replaceState(null, "", "/timeline?view=calendar");
  render(<TimelineBrowser />);
  await screen.findByText("No photos with capture dates yet");
  expect(screen.queryByRole("region", { name: /Daily photography calendar \d/ })).toBeNull();
  expect(screen.getByLabelText("Capture year")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Photography activity summary").textContent).not.toContain("NaN");
  expect(window.location.search).toBe("?view=calendar");
});

test("shows all twelve empty months for a valid year without Photos", async () => {
  api.getPhotoCalendar.mockResolvedValue(calendar(2024, { days: [], photo_count: 0, active_days: 0, max_daily_count: 0 }));
  render(<TimelineBrowser />);
  await screen.findByText("No active photos in this year");
  expect(screen.getByRole("region", { name: "December 2024" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /^Most active day:/ })).toBeNull();
});

test("shows a safe error and Retry recovers", async () => {
  api.getPhotoCalendar.mockRejectedValueOnce(new Error("private backend detail")).mockResolvedValue(calendar());
  render(<TimelineBrowser />);
  await screen.findByText("Could not load the photography calendar");
  expect(screen.queryByText("private backend detail")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("region", { name: "February 2024" });
});

test("aborts obsolete requests, hides old data immediately and ignores late success and failure", async () => {
  let finish!: (value: CalendarResponse) => void;
  let fail!: (error: Error) => void;
  api.getPhotoCalendar.mockResolvedValueOnce(calendar())
    .mockImplementationOnce(() => new Promise<CalendarResponse>((resolve) => { finish = resolve; }))
    .mockImplementationOnce(() => new Promise<CalendarResponse>((_, reject) => { fail = reject; }))
    .mockResolvedValue(calendar(2024));
  const view = render(<TimelineBrowser />);
  await screen.findByRole("region", { name: "February 2024" });
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2025");
  await waitFor(() => expect(api.getPhotoCalendar).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("region", { name: "February 2024" })).toBeNull();
  const obsolete = api.getPhotoCalendar.mock.calls[1][1] as AbortSignal;
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2026");
  await waitFor(() => expect(api.getPhotoCalendar).toHaveBeenCalledTimes(3));
  expect(obsolete.aborted).toBe(true);
  await act(async () => { finish(calendar(2025, { days: [] })); });
  expect(screen.queryByRole("region", { name: "February 2025" })).toBeNull();
  await userEvent.selectOptions(screen.getByLabelText("Capture year"), "2024");
  await screen.findByRole("region", { name: "February 2024" });
  await act(async () => { fail(new Error("late failure")); });
  expect(screen.queryByRole("alert")).toBeNull();
  const signal = api.getPhotoCalendar.mock.calls.at(-1)![1] as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});
