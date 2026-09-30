import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import DuplicateBrowser from "../app/duplicates/duplicate-browser";
import type { DuplicateComparison, DuplicateReview, DuplicateSummary, Photo } from "../app/lib/api";

const api = vi.hoisted(() => ({ getDuplicateReview: vi.fn(), getDuplicateSummary: vi.fn(), dismissDuplicate: vi.fn(), deletePhoto: vi.fn() }));
const navigation = vi.hoisted(() => ({ search: "left=1&right=2", push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push, replace: navigation.replace }), useSearchParams: () => new URLSearchParams(navigation.search) }));
vi.mock("../app/lib/api", async (original) => ({ ...await original<typeof import("../app/lib/api")>(), ...api }));
vi.mock("../app/components/photo-detail/photo-media", () => ({ default: ({ photo }: { photo: Photo }) => <div>Preview {photo.id}</div> }));

function photo(id: number): Photo {
  return { extracted_captured_at: null, extracted_captured_at_offset_minutes: null, extracted_latitude: null, extracted_longitude: null, capture_metadata_overridden: false, location_metadata_overridden: false, id, original_filename: `fox-${id}.jpg`, stored_filename: `${id}.jpg`, resized_filename: `${id}-resized.jpg`, thumbnail_filename: `${id}-thumb.jpg`, display_title: null, common_name: "Fox", breed_guess: null, species_guess: "Vulpes vulpes", category: "mammal", confidence: null, description: null, tags: [], status: "pending", animal_id: null, content_sha256: `${id}`, original_size_bytes: 1048576, media_type: "image/jpeg", captured_at: "2024-05-24T18:42:00", captured_at_offset_minutes: 120, camera_make: "SONY", camera_model: "Alpha", lens_model: null, image_width: 640, image_height: 480, latitude: null, longitude: null, deleted_at: null, reviewed_at: null, created_at: "2026-09-01T12:00:00", updated_at: "2026-09-01T12:00:00" };
}
const pair: DuplicateComparison = { identity: { left: 1, right: 2 }, left_photo: photo(1), right_photo: photo(2), detector: "phash64-v1:d4", distance: 2, discovered_at: "2026-09-01T12:00:00" };
function review(overrides: Partial<DuplicateReview> = {}): DuplicateReview {
  return { pair, total: 2, previous: null, next: { left: 2, right: 3 }, first: { left: 1, right: 2 }, requested_pair_unavailable: false, ...overrides };
}
function summary(overrides: Partial<DuplicateSummary> = {}): DuplicateSummary {
  return { unresolved: 2, dismissed: 0, detector: "phash64-v1:d4", threshold: 4, missing_fingerprints: 0, scan: null, ...overrides };
}
beforeEach(() => {
  vi.clearAllMocks();
  navigation.search = "left=1&right=2";
  api.getDuplicateReview.mockResolvedValue(review());
  api.getDuplicateSummary.mockResolvedValue(summary());
  api.dismissDuplicate.mockResolvedValue({ remaining: 0, next: null });
  api.deletePhoto.mockResolvedValue({ status: "trashed", photo_id: 1 });
});

test("shows pair evidence, metadata and restorable Photo links", async () => {
  render(<DuplicateBrowser />);
  expect(await screen.findByText("Fingerprint distance 2; review threshold 4")).toBeTruthy();
  const left = screen.getByRole("region", { name: "Left photo" });
  expect(within(left).getByText("fox-1.jpg")).toBeTruthy();
  expect(within(left).getByText("640 × 480")).toBeTruthy();
  expect(within(left).getByText("SONY Alpha")).toBeTruthy();
  expect(within(left).getByText(/Original size: 1 MB/)).toBeTruthy();
  expect(within(left).getByRole("link", { name: "Open left photo" }).getAttribute("href")).toBe("/photos/1?returnTo=%2Fduplicates%3Fleft%3D1%26right%3D2");
  expect(api.getDuplicateReview).toHaveBeenCalledWith({ left: 1, right: 2 }, expect.any(AbortSignal));
  expect(screen.getByText(/A full archive scan has not been run/)).toBeTruthy();
});

test("Skip navigates without dismissing and wraps to the first pair", async () => {
  const user = userEvent.setup();
  api.getDuplicateReview.mockResolvedValue(review({ next: null, previous: { left: 1, right: 2 }, pair: { ...pair, identity: { left: 2, right: 3 } } }));
  render(<DuplicateBrowser />);
  await user.click(await screen.findByRole("button", { name: "Skip" }));
  expect(navigation.push).toHaveBeenCalledWith("/duplicates?left=1&right=2", { scroll: false });
  expect(api.dismissDuplicate).not.toHaveBeenCalled();
  expect(api.deletePhoto).not.toHaveBeenCalled();
});

test("single remaining pair stays unresolved on Skip", async () => {
  api.getDuplicateReview.mockResolvedValue(review({ total: 1, next: null }));
  render(<DuplicateBrowser />);
  await userEvent.click(await screen.findByRole("button", { name: "Skip" }));
  expect(screen.getByText(/only unresolved pair/)).toBeTruthy();
  expect(navigation.push).not.toHaveBeenCalled();
  expect(api.dismissDuplicate).not.toHaveBeenCalled();
});

test("Keep both dismisses only the current pair and shows completion", async () => {
  api.getDuplicateReview.mockResolvedValueOnce(review()).mockResolvedValue(review({ pair: null, total: 0 }));
  render(<DuplicateBrowser />);
  await userEvent.click(await screen.findByRole("button", { name: "Keep both / Not duplicates" }));
  expect(await screen.findByText("No possible duplicates need review.")).toBeTruthy();
  expect(api.dismissDuplicate).toHaveBeenCalledExactlyOnceWith(pair);
  expect(api.deletePhoto).not.toHaveBeenCalled();
  expect(navigation.replace).toHaveBeenCalledWith("/duplicates", { scroll: false });
});

test("blocks duplicate submissions and navigation while Keep both is pending", async () => {
  let finish!: (value: { remaining: number; next: null }) => void;
  api.dismissDuplicate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<DuplicateBrowser />);
  const button = await screen.findByRole<HTMLButtonElement>("button", { name: "Keep both / Not duplicates" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.dismissDuplicate).toHaveBeenCalledTimes(1);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Skip" }).disabled).toBe(true);
  finish({ remaining: 0, next: null });
  await waitFor(() => expect(button.disabled).toBe(false));
});

test.each([ ["left", 1], ["right", 2] ] as const)("confirms %s Trash action and refreshes the queue", async (side, id) => {
  render(<DuplicateBrowser />);
  await userEvent.click(await screen.findByRole("button", { name: `Move ${side} photo to Trash` }));
  const dialog = screen.getByRole("dialog", { name: "Move photo to Trash?" });
  expect(within(dialog).getByText(new RegExp(`fox-${id}.jpg`))).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Skip" }).disabled).toBe(true);
  expect(api.deletePhoto).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
  await waitFor(() => expect(api.deletePhoto).toHaveBeenCalledExactlyOnceWith(id));
  expect(await screen.findByText(new RegExp(`Moved fox-${id}.jpg to Trash`))).toBeTruthy();
});

test("Trash cancellation preserves state and dialog errors remain retryable", async () => {
  api.deletePhoto.mockRejectedValueOnce(new Error("Trash failed"));
  render(<DuplicateBrowser />);
  await userEvent.click(await screen.findByRole("button", { name: "Move left photo to Trash" }));
  const dialog = screen.getByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Move to Trash" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Trash failed");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Skip" }).disabled).toBe(true);
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Skip" }).disabled).toBe(false);
});

test("empty state retains incomplete and missing-fingerprint coverage", async () => {
  api.getDuplicateReview.mockResolvedValue(review({ pair: null, total: 0 }));
  api.getDuplicateSummary.mockResolvedValue(summary({ missing_fingerprints: 5, scan: { status: "incomplete", started_at: "2026-09-01T12:00:00", completed_at: null, last_successful_at: null, processed: 20, skipped: 5, pairs: 10, probes: 50, reason: "Pair limit reached" } }));
  render(<DuplicateBrowser />);
  expect(await screen.findByText("No possible duplicates need review.")).toBeTruthy();
  expect(screen.getByText(/Archive scan incomplete: Pair limit reached/)).toBeTruthy();
  expect(screen.getByText(/5 photos have no fingerprint/)).toBeTruthy();
});

test("handles API load failures and retries", async () => {
  api.getDuplicateReview.mockRejectedValueOnce(new Error("Review unavailable"));
  render(<DuplicateBrowser />);
  expect((await screen.findByRole("alert")).textContent).toContain("Review unavailable");
  expect(screen.queryByText("No possible duplicates need review.")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Fingerprint distance 2; review threshold 4")).toBeTruthy();
});

test("stale selected pair updates the URL and explains its disappearance", async () => {
  navigation.search = "left=8&right=9";
  api.getDuplicateReview.mockResolvedValue(review({ requested_pair_unavailable: true }));
  render(<DuplicateBrowser />);
  expect(await screen.findByText(/That pair no longer needs review/)).toBeTruthy();
  expect(navigation.replace).toHaveBeenCalledWith("/duplicates?left=1&right=2", { scroll: false });
});

test("decision errors preserve the comparison", async () => {
  api.dismissDuplicate.mockRejectedValue(new Error("Pair changed; refresh"));
  render(<DuplicateBrowser />);
  await userEvent.click(await screen.findByRole("button", { name: "Keep both / Not duplicates" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Pair changed; refresh");
  expect(screen.getByText("Preview 1")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Skip" }).disabled).toBe(false);
});
