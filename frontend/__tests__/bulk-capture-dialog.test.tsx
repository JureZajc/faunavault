import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import BulkCaptureDialog from "../app/components/catalog/bulk-capture-dialog";
import { ApiError, BulkCaptureOperation, BulkCapturePreview } from "../app/lib/api";

const api = vi.hoisted(() => ({ previewBulkCapture: vi.fn(), applyBulkCapture: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...(await original<typeof import("../app/lib/api")>()), ...api }));
const onClose = vi.fn();
const onSuccess = vi.fn();

function preview(change: BulkCaptureOperation): BulkCapturePreview {
  const before = { captured_at: "2024-02-29T23:30:00", captured_at_offset_minutes: null, latitude: null, longitude: null, capture_metadata_overridden: false, location_metadata_overridden: false };
  return { change, selected_count: 2, affected_count: 2, blocked_count: 0, can_apply: true,
    photos: [1, 2].map((photo_id) => ({ photo_id, filename: `photo-${photo_id}.jpg`, updated_at: `version-${photo_id}`, original_sha256: null, before, after: { ...before, captured_at: "2024-03-01T00:30:00", capture_metadata_overridden: true }, changed: true, issue: null })) };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.previewBulkCapture.mockImplementation(async ({ change }) => preview(change));
  api.applyBulkCapture.mockResolvedValue({ status: "completed", photo_ids: [1, 2], affected_count: 2 });
});

function open() { render(<BulkCaptureDialog photoIds={[1, 2]} onClose={onClose} onSuccess={onSuccess} />); }
async function showPreview() { await userEvent.click(screen.getByRole("button", { name: "Preview changes" })); await screen.findByRole("table"); }
async function confirmAndApply() {
  await userEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  await userEvent.click(screen.getByRole("button", { name: "Apply changes" }));
}

test("preview includes all rows and requires confirmation; apply uses exact preview versions", async () => {
  open();
  expect(document.activeElement).toBe(screen.getByLabelText("Operation"));
  await showPreview();
  expect(api.applyBulkCapture).not.toHaveBeenCalled();
  expect(screen.getByText("photo-1.jpg")).toBeTruthy();
  expect(screen.getByText("photo-2.jpg")).toBeTruthy();
  expect(screen.getByText(/2 selected, 2 affected, 0 cannot/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Apply changes" }) as HTMLButtonElement).disabled).toBe(true);
  await confirmAndApply();
  expect(api.applyBulkCapture).toHaveBeenCalledExactlyOnceWith({ photo_ids: [1, 2], change: { operation: "shift_time", minutes: 60 }, expected_versions: [{ photo_id: 1, updated_at: "version-1", original_sha256: null }, { photo_id: 2, updated_at: "version-2", original_sha256: null }] });
  expect(onSuccess).toHaveBeenCalledWith({ status: "completed", photo_ids: [1, 2], affected_count: 2 });
});

test.each([
  ["clear_capture", { operation: "clear_capture" }],
  ["remove_gps", { operation: "remove_gps" }],
  ["restore_original", { operation: "restore_original", group: "capture" }],
  ["set_gps", { operation: "set_gps", latitude: 46.2, longitude: 14.3 }],
  ["set_capture", { operation: "set_capture", captured_at: "2024-02-29T12:30:00", offset_mode: "preserve" }],
])("operation %s sends typed values", async (operation, expected) => {
  open();
  await userEvent.selectOptions(screen.getByLabelText("Operation"), operation as string);
  if (operation === "restore_original") await userEvent.selectOptions(screen.getByLabelText("Restore group"), "capture");
  if (operation === "set_gps") {
    await userEvent.type(screen.getByLabelText("Latitude"), "46.2");
    await userEvent.type(screen.getByLabelText("Longitude"), "14.3");
  }
  if (operation === "set_capture") await userEvent.type(screen.getByLabelText("Camera-local date and time"), "2024-02-29T12:30");
  await showPreview();
  expect(api.previewBulkCapture).toHaveBeenCalledWith({ photo_ids: [1, 2], change: expected });
});

test.each([["unknown", "", null], ["assign", "-05:30", -330]])("set capture explicitly supports %s offset", async (mode, offset, minutes) => {
  open();
  await userEvent.selectOptions(screen.getByLabelText("Operation"), "set_capture");
  await userEvent.type(screen.getByLabelText("Camera-local date and time"), "2024-02-29T12:30:00");
  await userEvent.selectOptions(screen.getByLabelText("UTC offset handling"), mode as string);
  if (offset) await userEvent.type(screen.getByLabelText("UTC offset", { exact: true }), offset as string);
  await showPreview();
  expect(api.previewBulkCapture).toHaveBeenCalledWith({ photo_ids: [1, 2], change: { operation: "set_capture", captured_at: "2024-02-29T12:30:00", offset_mode: "assign", captured_at_offset_minutes: minutes } });
});

test.each([
  ["shift_time", "Signed minutes", "1.5", /whole number/],
  ["set_capture", "Camera-local date and time", "2025-02-29T12:00", /valid camera-local/],
  ["set_gps", "Latitude", "46", /both latitude and longitude/],
])("invalid %s form is rejected locally", async (operation, field, value, message) => {
  open();
  await userEvent.selectOptions(screen.getByLabelText("Operation"), operation as string);
  await userEvent.clear(screen.getByLabelText(field as string));
  await userEvent.type(screen.getByLabelText(field as string), value as string);
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect(screen.getByRole("alert").textContent).toMatch(message as RegExp);
  expect(api.previewBulkCapture).not.toHaveBeenCalled();
});

test("editing configuration invalidates preview and confirmation", async () => {
  open();
  await showPreview();
  await userEvent.click(screen.getByRole("checkbox", { name: /I reviewed/ }));
  await userEvent.type(screen.getByLabelText("Signed minutes"), "0");
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByRole("button", { name: "Apply changes" })).toBeNull();
  await showPreview();
  expect((screen.getByRole("checkbox", { name: /I reviewed/ }) as HTMLInputElement).checked).toBe(false);
});

test("missing capture time blocks whole selection and shows the issue", async () => {
  const result = preview({ operation: "shift_time", minutes: 60 });
  result.can_apply = false;
  result.blocked_count = 1;
  result.affected_count = 1;
  result.photos[1] = { ...result.photos[1], after: null, changed: false, issue: { code: "missing_capture_time", message: "No capture timestamp to shift. Deselect this photo." } };
  api.previewBulkCapture.mockResolvedValue(result);
  open();
  await showPreview();
  expect(screen.getByText(/No capture timestamp/)).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /I reviewed/ }) as HTMLInputElement).disabled).toBe(true);
});

test.each([new ApiError("Selected photos changed since preview.", 409, { code: "photos_changed" }), new Error("Server unavailable")])("apply failure requires fresh preview and never retries", async (failure) => {
  api.applyBulkCapture.mockRejectedValue(failure);
  open();
  await showPreview();
  await confirmAndApply();
  expect((await screen.findByRole("alert")).textContent).toMatch(/selection is preserved.*Preview changes again/);
  expect(screen.queryByRole("table")).toBeNull();
  expect(api.applyBulkCapture).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  expect(onSuccess).not.toHaveBeenCalled();
});

test("preview errors are actionable and cancel restores keyboard focus", async () => {
  api.previewBulkCapture.mockRejectedValue(new Error("One selected photo is in Trash."));
  open();
  await userEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Trash");
  screen.getByLabelText("Operation").focus();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview changes" }));
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("repeated submissions and Escape are blocked while a request is pending", async () => {
  let resolve!: (value: BulkCapturePreview) => void;
  api.previewBulkCapture.mockImplementation(() => new Promise((done) => { resolve = done; }));
  open();
  const form = screen.getByRole("dialog");
  fireEvent.submit(form);
  fireEvent.submit(form);
  fireEvent.keyDown(form, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(api.previewBulkCapture).toHaveBeenCalledTimes(1);
  await act(async () => resolve(preview({ operation: "shift_time", minutes: 60 })));
  await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
});
