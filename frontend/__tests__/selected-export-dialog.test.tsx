import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import SelectedExportDialog from "../app/components/catalog/selected-export-dialog";

const api = vi.hoisted(() => ({ estimateSelectedExport: vi.fn(), prepareSelectedExport: vi.fn(), downloadSelectedExport: vi.fn() }));
vi.mock("../app/lib/api", () => api);

beforeEach(() => {
  vi.resetAllMocks();
  api.estimateSelectedExport.mockResolvedValue({ estimated_download_bytes: 1048576 });
  api.prepareSelectedExport.mockResolvedValue({ download_path: "/exports/selected/token" });
});

test("configuration, cancel, focus trap and explicit confirmation", async () => {
  const close = vi.fn();
  render(<SelectedExportDialog photoIds={[12, 34]} onClose={close} />);
  const cancel = screen.getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  await screen.findByText(/Estimated total download size: 1 MiB/);
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("checkbox"));
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm and download ZIP" }));
  await userEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(api.estimateSelectedExport).toHaveBeenLastCalledWith({ photo_ids: [12, 34], mode: "originals", include_metadata: true }, expect.any(AbortSignal)));
  expect(api.prepareSelectedExport).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(close).toHaveBeenCalledOnce();
});

test("preparation failure keeps configuration and permits retry", async () => {
  api.prepareSelectedExport.mockRejectedValueOnce(new Error("Original changed; retry"));
  render(<SelectedExportDialog photoIds={[12, 34]} onClose={vi.fn()} />);
  await screen.findByText(/Estimated total download size/);
  await userEvent.click(screen.getByRole("checkbox"));
  await screen.findByText(/Estimated total download size/);
  await userEvent.click(screen.getByRole("button", { name: "Confirm and download ZIP" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Original changed");
  expect(api.downloadSelectedExport).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
  await userEvent.click(screen.getByRole("button", { name: "Confirm and download ZIP" }));
  await screen.findByText(/Download requested/);
  expect(api.downloadSelectedExport).toHaveBeenCalledWith("/exports/selected/token");
});

test("estimate failure disables confirmation and can be retried", async () => {
  api.estimateSelectedExport.mockRejectedValueOnce(new Error("Photo is in Trash"));
  render(<SelectedExportDialog photoIds={[12]} onClose={vi.fn()} />);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Confirm and download ZIP" })).toHaveProperty("disabled", true);
  await userEvent.click(screen.getByRole("button", { name: "Retry estimate" }));
  await screen.findByText(/Estimated total download size/);
  expect(screen.getByRole("button", { name: "Confirm and download ZIP" })).toHaveProperty("disabled", false);
});

test("browser download failure is visible and a fresh download can be prepared", async () => {
  api.downloadSelectedExport.mockImplementationOnce(() => { throw new Error("Download could not start"); });
  render(<SelectedExportDialog photoIds={[12]} onClose={vi.fn()} />);
  await screen.findByText(/Estimated total download size/);
  await userEvent.click(screen.getByRole("button", { name: "Confirm and download ZIP" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Download could not start");
  await userEvent.click(screen.getByRole("button", { name: "Confirm and download ZIP" }));
  await screen.findByText(/Download requested/);
});
