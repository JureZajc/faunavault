import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import ReviewBrowser from "../app/review/review-browser";
import type { Photo, ReviewInbox } from "../app/lib/api";

const api = vi.hoisted(() => ({
  getReviewInbox: vi.fn(),
  acceptReview: vi.fn(),
  classifyPhoto: vi.fn(),
  updatePhoto: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));
const jobs = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  error: null as string | null,
  hasActiveJobs: false,
  acceptEnqueue: vi.fn(),
  retry: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));
vi.mock("../app/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/api")>()),
  ...api,
}));
vi.mock("../app/hooks/use-classification-jobs", () => ({
  useClassificationJobs: () => jobs,
}));
vi.mock("../app/components/photo-detail/photo-media", () => ({
  default: ({ photo }: { photo: Photo }) => <div>Preview {photo.id}</div>,
}));
vi.mock("../app/components/photo-detail/photo-animal-section", () => ({
  default: () => <div>Animal taxonomy</div>,
}));

function photo(id: number): Photo {
  return {
    id,
    original_filename: `photo-${id}.jpg`,
    stored_filename: `photo-${id}.jpg`,
    resized_filename: `photo-${id}-resized.jpg`,
    thumbnail_filename: `photo-${id}-thumb.jpg`,
    display_title: `Photo ${id}`,
    common_name: "fox",
    breed_guess: null,
    species_guess: "Vulpes vulpes",
    category: "mammal",
    confidence: 0.4,
    description: "A fox",
    tags: ["wildlife"],
    status: "needs_review",
    animal_id: null,
    content_sha256: null,
    original_size_bytes: null,
    media_type: "image/jpeg",
    captured_at: null,
    captured_at_offset_minutes: null,
    camera_make: null,
    camera_model: null,
    lens_model: null,
    image_width: null,
    image_height: null,
    latitude: null,
    longitude: null,
    deleted_at: null,
    reviewed_at: null,
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
  };
}

function inbox(current: Photo | null, overrides: Partial<ReviewInbox> = {}): ReviewInbox {
  return {
    total: current ? 2 : 0,
    photo: current,
    position: current ? 1 : null,
    previous_photo_id: null,
    next_photo_id: current ? 2 : null,
    requested_photo_unavailable: false,
    low_confidence: Boolean(current),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  navigation.search = "photo=1";
  jobs.jobs = [];
  jobs.error = null;
  jobs.hasActiveJobs = false;
  api.getReviewInbox.mockResolvedValue(inbox(photo(1)));
});

test("shows a completed inbox", async () => {
  api.getReviewInbox.mockResolvedValue(inbox(null));
  render(<ReviewBrowser />);
  expect(await screen.findByText("All caught up")).toBeTruthy();
  expect(screen.getByText("There are no photos left to review.")).toBeTruthy();
});

test("accept advances to the next review photo", async () => {
  api.acceptReview.mockResolvedValue({ accepted_photo_id: 1, remaining: 1, next_photo_id: 2 });
  render(<ReviewBrowser />);
  await screen.findByText("Preview 1");
  await userEvent.click(screen.getByRole("button", { name: "Accept" }));
  expect(api.acceptReview).toHaveBeenCalledWith(1, photo(1).updated_at);
  expect(navigation.replace).toHaveBeenCalledWith("/review?photo=2", { scroll: false });
});

test("metadata edit uses the guarded photo API and advances", async () => {
  api.updatePhoto.mockResolvedValue(photo(1));
  api.updatePhoto.mockImplementation(async () => ({
    ...photo(1), status: "classified", reviewed_at: "2026-01-01T01:00:00",
  }));
  render(<ReviewBrowser />);
  await screen.findByText("Preview 1");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.clear(screen.getByRole("textbox", { name: "Display title" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Display title" }), "Edited fox");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/review?photo=2", { scroll: false }));
  expect(api.updatePhoto).toHaveBeenCalledWith(1, expect.any(Object), photo(1).updated_at);
});

test("falls back when the requested photo was edited or trashed elsewhere", async () => {
  api.getReviewInbox.mockResolvedValue(inbox(photo(2), {
    position: 1,
    total: 1,
    next_photo_id: null,
    requested_photo_unavailable: true,
  }));
  render(<ReviewBrowser />);
  expect(await screen.findByText("That photo is no longer in the Review Inbox.")).toBeTruthy();
  expect(navigation.replace).toHaveBeenCalledWith("/review?photo=2", { scroll: false });
});

test("shows failed jobs, Ollama errors, and a retry action", async () => {
  jobs.jobs = [{
    id: 9, photo_id: 1, status: "failed", batch_id: "b", batch_kind: "single",
    requested_model: "local-model", fallback_model: null, actual_model: null,
    fallback_attempted: false, prompt_version: "v1", attempt_count: 1,
    created_at: "2026-01-01", queued_at: "2026-01-01", started_at: null,
    finished_at: null, duration_ms: null, failure_code: "ollama_unavailable",
    failure_message: "Ollama is unavailable", classification_status: null,
    photo_original_filename: "photo-1.jpg", retryable: true,
  }];
  render(<ReviewBrowser />);
  expect(await screen.findByText("Ollama is unavailable")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(jobs.retry).toHaveBeenCalledWith(9);
});

test("shows a load error and lets the user retry", async () => {
  api.getReviewInbox.mockRejectedValueOnce(new Error("API unavailable"));
  render(<ReviewBrowser />);
  expect(await screen.findByText("API unavailable")).toBeTruthy();
  api.getReviewInbox.mockResolvedValue(inbox(photo(1)));
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByText("Preview 1")).toBeTruthy());
});

test("arrow navigation moves between review items without changing metadata", async () => {
  render(<ReviewBrowser />);
  await screen.findByText("Preview 1");
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(navigation.push).toHaveBeenCalledWith("/review?photo=2", { scroll: false });
  expect(api.acceptReview).not.toHaveBeenCalled();
});
