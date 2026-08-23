import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import Home from "../app/page";
import ClassificationJobsPanel from "../app/components/classification-jobs-panel";
import {
  ClassificationEnqueueResponse,
  ClassificationJob,
  Photo,
} from "../app/lib/api";

const api = vi.hoisted(() => ({
  classifyPendingPhotos: vi.fn(),
  getClassificationJobs: vi.fn(),
  getCatalogPhotos: vi.fn(),
  retryClassificationJob: vi.fn(),
}));

vi.mock("../app/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../app/lib/api")>();
  return { ...original, ...api };
});

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: 7,
    original_filename: "fox.jpg",
    stored_filename: "fox.jpg",
    resized_filename: "fox-resized.jpg",
    thumbnail_filename: "fox-thumb.jpg",
    display_title: null,
    common_name: null,
    breed_guess: null,
    species_guess: null,
    category: null,
    confidence: null,
    description: null,
    tags: [],
    status: "pending",
    animal_id: 4,
    content_sha256: "a".repeat(64),
    original_size_bytes: 100,
    media_type: "image/jpeg",
    captured_at: null, captured_at_offset_minutes: null,
    camera_make: null, camera_model: null, lens_model: null,
    image_width: null, image_height: null, latitude: null, longitude: null,
    deleted_at: null,
    created_at: "2026-08-10T08:00:00Z",
    updated_at: "2026-08-11T08:00:00Z",
    ...overrides,
  };
}

function job(overrides: Partial<ClassificationJob> = {}): ClassificationJob {
  return {
    id: 20,
    photo_id: 7,
    status: "queued",
    batch_id: "batch-1",
    batch_kind: "pending_batch",
    requested_model: "primary",
    fallback_model: "fallback",
    actual_model: null,
    fallback_attempted: false,
    prompt_version: "animal-photo-v1",
    attempt_count: 1,
    created_at: "2026-08-12T08:00:00Z",
    queued_at: "2026-08-12T08:00:00Z",
    started_at: null,
    finished_at: null,
    duration_ms: null,
    failure_code: null,
    failure_message: null,
    classification_status: null,
    photo_original_filename: "fox.jpg",
    retryable: false,
    ...overrides,
  };
}

function collection(jobs: ClassificationJob[]) {
  return {
    jobs,
    summary: {
      total: jobs.length,
      queued: jobs.filter((item) => item.status === "queued").length,
      running: jobs.filter((item) => item.status === "running").length,
      succeeded: jobs.filter((item) => item.status === "succeeded").length,
      failed: jobs.filter((item) => item.status === "failed").length,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
  api.getCatalogPhotos.mockImplementation(async (query) => ({
    items: [photo()],
    total: 1,
    page: query.page,
    page_size: query.page_size,
    total_pages: 1,
    facets: {
      active_total: 1,
      status_counts: { pending: 1, classified: 0, needs_review: 0 },
      categories: [],
      uncategorized_count: 1,
    },
  }));
  api.getClassificationJobs.mockResolvedValue(collection([]));
});

test("enqueues one backend batch and renders queued state", async () => {
  const response: ClassificationEnqueueResponse = {
    jobs: [{ job: job(), created: true }],
    rejected: [],
    summary: { total: 1, queued: 1, running: 0, succeeded: 0, failed: 0 },
  };
  api.classifyPendingPhotos.mockResolvedValue(response);
  api.getClassificationJobs
    .mockResolvedValueOnce(collection([]))
    .mockResolvedValue(collection([job()]));
  render(<Home />);

  await userEvent.click(
    await screen.findByRole("button", { name: "Classify pending photos" }),
  );

  await waitFor(() => expect(api.classifyPendingPhotos).toHaveBeenCalledTimes(1));
  expect(await screen.findAllByText("Queued")).toHaveLength(2);
  expect(screen.getByText(/1 queued/)).toBeTruthy();
});

test("recovers a failed job after remount and retries it explicitly", async () => {
  const failed = job({
    status: "failed",
    failure_code: "ollama_unavailable",
    failure_message: "Could not connect to Ollama.",
    retryable: true,
  });
  let serverJobs = [failed];
  api.getClassificationJobs.mockImplementation(async () => collection(serverJobs));
  api.retryClassificationJob.mockImplementation(async () => {
    const retried = job({ id: failed.id, attempt_count: 2 });
    serverJobs = [retried];
    return retried;
  });
  const first = render(<Home />);

  expect(await screen.findByText("Could not connect to Ollama.")).toBeTruthy();
  first.unmount();
  render(<Home />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

  await waitFor(() => expect(api.retryClassificationJob).toHaveBeenCalledWith(20));
  expect(await screen.findAllByText("Queued")).toHaveLength(2);
});

test("shows successful low-confidence work as needs review", () => {
  render(
    <ClassificationJobsPanel
      jobs={[
      job({
        status: "succeeded",
        actual_model: "fallback",
        classification_status: "needs_review",
      }),
      ]}
      onRetry={vi.fn()}
    />,
  );
  expect(screen.getByText("Needs review with fallback")).toBeTruthy();
  expect(screen.getByText("Needs review")).toBeTruthy();
});

test("hides a stale successful batch when new pending photos exist", async () => {
  api.getClassificationJobs.mockResolvedValue(
    collection([
      job({
        status: "succeeded",
        actual_model: "primary",
        batch_kind: "reclassification",
        photo_original_filename: "already-classified.jpg",
      }),
    ]),
  );

  render(<Home />);

  expect(await screen.findByText("1 pending photo")).toBeTruthy();
  expect(screen.queryByText("already-classified.jpg")).toBeNull();
  expect(screen.queryByText(/Total 1 .* 1 succeeded/)).toBeNull();
  expect(
    (screen.getByRole("button", {
      name: "Classify pending photos",
    }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("preserves long job filenames and provenance without hiding retry", async () => {
  const filename = `${"field-record-".repeat(12)}.jpg`;
  const model = `local-model-${"variant".repeat(12)}`;
  api.getClassificationJobs.mockResolvedValue(
    collection([
      job({
        status: "failed",
        photo_original_filename: filename,
        failure_message: `Failure from ${model}`,
        retryable: true,
      }),
    ]),
  );

  render(<Home />);

  expect((await screen.findByTitle(filename)).textContent).toBe(filename);
  expect(screen.getByText(`Failure from ${model}`)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("renders stable reliability failures and mixed job states independently", async () => {
  const onRetry = vi.fn();
  render(
    <ClassificationJobsPanel
      jobs={[
        job({
          id: 21,
          status: "failed",
          failure_code: "ollama_timeout",
          failure_message: "Ollama did not complete classification before the timeout.",
          retryable: true,
        }),
        job({
          id: 22,
          status: "failed",
          failure_code: "ollama_model_unavailable",
          failure_message: "The configured Ollama model is unavailable.",
          retryable: true,
        }),
        job({ id: 23, status: "running" }),
        job({ id: 24, status: "succeeded", actual_model: "primary" }),
        job({ id: 25, status: "queued" }),
      ]}
      onRetry={onRetry}
    />,
  );

  expect(
    screen.getByText("Ollama did not complete classification before the timeout."),
  ).toBeTruthy();
  expect(
    screen.getByText("The configured Ollama model is unavailable."),
  ).toBeTruthy();
  expect(screen.getByText("Total 5 · 1 queued · 1 running · 1 succeeded · 2 failed"))
    .toBeTruthy();
  expect(screen.getAllByText("Classifying")).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(2);
});
