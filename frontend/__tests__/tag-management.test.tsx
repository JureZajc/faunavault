import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import TagsBrowser from "../app/tags/tags-browser";
import { ApiError, TagOperationPreview, TagOperationRequest } from "../app/lib/api";

const api = vi.hoisted(() => ({ getCatalogTags: vi.fn(), previewTagOperation: vi.fn(), applyTagOperation: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));

function snapshot(request: TagOperationRequest): TagOperationPreview {
  return { ...request, active_photos: 2, trashed_photos: 1, destination_overlap: 1, total_photos: 3, destination_exists: request.destination === "birds", preview_token: "signed-preview", examples: [{ photo_id: 1, filename: "bird.jpg", trashed: false, before: ["bird", "other"], after: request.operation === "delete" ? ["other"] : [request.destination, "other"] }] };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.getCatalogTags.mockResolvedValue({ tags: [{ name: "bird", count: 2 }, { name: "birds", count: 1 }], total_tags: 2, untagged_count: 0 });
  api.previewTagOperation.mockImplementation(async (request) => snapshot(request));
  api.applyTagOperation.mockImplementation(async (request) => ({ operation: request.operation, source: request.source, destination: request.destination, updated_photos: 3, active_photos: 2, trashed_photos: 1 }));
});

async function open(operation = "Rename") {
  render(<TagsBrowser />);
  const trigger = await screen.findByRole("button", { name: `${operation} tag bird` });
  await userEvent.click(trigger);
  return trigger;
}

test.each(["Rename", "Merge"])("%s form previews counts, examples and applies once, then refreshes counts", async (action) => {
  await open(action);
  const dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(screen.getByLabelText(/Destination tag/));
  await userEvent.type(screen.getByLabelText(/Destination tag/), "birds");
  await userEvent.click(within(dialog).getByRole("button", { name: "Preview changes" }));
  await screen.findByText("3 total Photos will be updated");
  expect(screen.getByText("2 active Photos affected")).toBeTruthy();
  expect(screen.getByText("1 Trashed Photos affected")).toBeTruthy();
  expect(screen.getByText(/1 affected Photos already contain/)).toBeTruthy();
  expect(screen.getByText('Before: ["bird","other"]')).toBeTruthy();
  expect(screen.getByText('After: ["birds","other"]')).toBeTruthy();
  if (action === "Rename") expect(screen.getByText(/This rename will merge/)).toBeTruthy();
  expect(api.applyTagOperation).not.toHaveBeenCalled();
  api.getCatalogTags.mockResolvedValue({ tags: [{ name: "birds", count: 2 }], total_tags: 1, untagged_count: 0 });
  await userEvent.click(screen.getByRole("button", { name: "Confirm changes" }));
  await screen.findByText(/Updated 3 Photos/);
  expect(screen.queryByRole("dialog")).toBeNull();
  await screen.findByRole("link", { name: "birds 2 photos" });
  expect(screen.queryByRole("button", { name: "Rename tag bird" })).toBeNull();
  expect(api.applyTagOperation).toHaveBeenCalledExactlyOnceWith({ operation: action.toLowerCase(), source: "bird", destination: "birds", preview_token: "signed-preview", confirm_delete: false });
});

test("delete requires explicit confirmation, has destructive styling and no destination", async () => {
  await open("Delete");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText(/Destination tag/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  const confirm = await screen.findByRole("button", { name: "Confirm delete tag" });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  expect(confirm.className).toContain("bg-red-700");
  await userEvent.click(confirm);
  expect(api.applyTagOperation).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("checkbox", { name: /Remove this tag from all/ }));
  await userEvent.click(confirm);
  await screen.findByText(/Deleted tag/);
  expect(api.applyTagOperation.mock.calls[0][0].confirm_delete).toBe(true);
});

test("stale preview disables apply until Retry Preview succeeds", async () => {
  await open();
  await userEvent.type(screen.getByLabelText(/Destination tag/), "birds");
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByText("3 total Photos will be updated");
  api.applyTagOperation.mockRejectedValueOnce(new ApiError("Archive tags changed.", 409, { code: "stale_preview" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm changes" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Refresh the preview");
  expect((screen.getByRole("button", { name: "Confirm changes" }) as HTMLButtonElement).disabled).toBe(true);
  api.previewTagOperation.mockImplementationOnce(async (request) => ({ ...snapshot(request), preview_token: "fresh-preview", total_photos: 4 }));
  await userEvent.click(screen.getByRole("button", { name: "Retry Preview" }));
  await screen.findByText("4 total Photos will be updated");
  await userEvent.click(screen.getByRole("button", { name: "Confirm changes" }));
  await screen.findByText(/Updated 3 Photos/);
  expect(api.applyTagOperation.mock.calls[1][0].preview_token).toBe("fresh-preview");
});

test("preview errors are recoverable and editing invalidates a previous preview", async () => {
  await open("Merge");
  await userEvent.type(screen.getByLabelText(/Destination tag/), "missing");
  api.previewTagOperation.mockRejectedValueOnce(new Error("Choose an existing archive tag."));
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByText("Choose an existing archive tag.");
  expect(screen.queryByRole("button", { name: "Confirm changes" })).toBeNull();
  await userEvent.clear(screen.getByLabelText(/Destination tag/));
  await userEvent.type(screen.getByLabelText(/Destination tag/), "birds");
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByText("3 total Photos will be updated");
  await userEvent.type(screen.getByLabelText(/Destination tag/), "2");
  expect(screen.queryByRole("button", { name: "Confirm changes" })).toBeNull();
});

test("modal traps keyboard focus, escapes and restores focus", async () => {
  const trigger = await open();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview changes" }));
  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByLabelText(/Destination tag/));
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("loading disables all controls and prevents duplicate submissions and Escape dismissal", async () => {
  let resolve!: (value: TagOperationPreview) => void;
  api.previewTagOperation.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await open();
  await userEvent.type(screen.getByLabelText(/Destination tag/), "birds");
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(screen.getByText("Loading preview…")).toBeTruthy();
  for (const control of within(screen.getByRole("dialog")).getAllByRole("button")) expect((control as HTMLButtonElement).disabled).toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => resolve(snapshot({ operation: "rename", source: "bird", destination: "birds" })));
  let finish!: (value: object) => void;
  api.applyTagOperation.mockImplementationOnce(() => new Promise((done) => { finish = done; }));
  await userEvent.dblClick(screen.getByRole("button", { name: "Confirm changes" }));
  expect(api.applyTagOperation).toHaveBeenCalledTimes(1);
  expect(screen.getByText("Applying changes…")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => finish({ operation: "rename", source: "bird", destination: "birds", updated_photos: 3, active_photos: 2, trashed_photos: 1 }));
});
