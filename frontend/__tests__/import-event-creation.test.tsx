import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import * as navigation from "next/navigation";
import ImportSessionSummary, { ImportSessionCard } from "../app/components/import-session-summary";
import { importEventAddHref, importSuggestedTitle } from "../app/lib/import-sessions";
import { parseCatalogState } from "../app/lib/catalog-query";
import { importSessionFixture } from "./fixtures/import-sessions";

const api = vi.hoisted(() => ({ getImportSession: vi.fn(), createEvent: vi.fn(), addEventPhotos: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...await original<typeof import("../app/lib/api")>(), ...api }));
const id = "b0ed3764-5211-4b54-9952-e3f29027dc21";
const item = importSessionFixture(id, { source_kind: "folder_import", label: "Slovenia", active_count: 3, imported_count: 3, dated_count: 2, undated_count: 1, earliest_capture_date: "2026-01-02", latest_capture_date: "2026-01-04" });
beforeEach(() => {
  vi.resetAllMocks(); window.history.replaceState(null, "", "/imports?page=2");
  api.getImportSession.mockResolvedValue(item); api.createEvent.mockResolvedValue({ id: 8 });
});
async function open() {
  render(<ImportSessionCard item={item} />);
  await userEvent.click(screen.getByRole("button", { name: "Create Trip/Event" }));
  return within(await screen.findByRole("dialog"));
}

test("prepopulates editable import suggestions, requires review, creates only metadata and preserves import scope", async () => {
  const dialog = await open();
  expect((dialog.getByLabelText("Type") as HTMLSelectElement).value).toBe("trip");
  expect((dialog.getByLabelText("Title") as HTMLInputElement).value).toBe("Slovenia");
  expect((dialog.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-01-02");
  expect((dialog.getByLabelText("End date") as HTMLInputElement).value).toBe("2026-01-04");
  expect((dialog.getByLabelText("Location (optional)") as HTMLInputElement).value).toBe("");
  expect(dialog.getByText(/2 active photos have capture dates; 1 have unknown/)).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Create Trip/Event" }));
  expect(api.createEvent).not.toHaveBeenCalled();
  await userEvent.clear(dialog.getByLabelText("Title")); await userEvent.type(dialog.getByLabelText("Title"), "Edited trip");
  fireEvent.change(dialog.getByLabelText("Start date"), { target: { value: "2025-12-31" } });
  await userEvent.click(dialog.getByRole("checkbox", { name: /reviewed and accept/ }));
  await userEvent.click(dialog.getByRole("button", { name: "Create Trip/Event" }));
  await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith({ kind: "trip", title: "Edited trip", start_date: "2025-12-31", end_date: "2026-01-04", location_label: null, notes: null }));
  expect(parseCatalogState(new URLSearchParams(window.location.search))).toMatchObject({ import_session_id: id, page: 1 });
  expect(new URLSearchParams(window.location.search).get("add_to_event")).toBe("8");
  expect(api.addEventPhotos).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Open new Trip/Event" }).getAttribute("href")).toBe("/events/8");
});

test("unknown dates require manual input; cancel and Escape restore focus without creating", async () => {
  api.getImportSession.mockResolvedValue({ ...item, earliest_capture_date: null, latest_capture_date: null, dated_count: 0, undated_count: 3 });
  const dialog = await open();
  expect(dialog.getByText(/Enter both dates manually/)).toBeTruthy();
  expect((dialog.getByLabelText("Start date") as HTMLInputElement).value).toBe("");
  await userEvent.click(dialog.getByRole("button", { name: "Create Trip/Event" }));
  expect(api.createEvent).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Create Trip/Event" })));
  expect(api.createEvent).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Create Trip/Event" }));
  const manual = within(await screen.findByRole("dialog"));
  fireEvent.change(manual.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
  fireEvent.change(manual.getByLabelText("End date"), { target: { value: "2026-03-02" } });
  await userEvent.click(manual.getByRole("button", { name: "Create Trip/Event" }));
  await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
});

test("errors retain edits and repeated submits and Escape cannot interrupt an in-flight save", async () => {
  let reject!: (error: Error) => void;
  api.createEvent.mockReturnValueOnce(new Promise((_resolve, failure) => { reject = failure; }));
  const dialog = await open();
  await userEvent.clear(dialog.getByLabelText("Title")); await userEvent.type(dialog.getByLabelText("Title"), "Keep edits");
  await userEvent.click(dialog.getByRole("checkbox"));
  const form = screen.getByRole("dialog");
  fireEvent.submit(form); fireEvent.submit(form);
  await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
  await userEvent.keyboard("{Escape}"); expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => reject(new Error("Backend unavailable")));
  expect((await dialog.findByRole("alert")).textContent).toContain("Backend unavailable");
  expect((dialog.getByLabelText("Title") as HTMLInputElement).value).toBe("Keep edits");
  await userEvent.click(dialog.getByRole("button", { name: "Create Trip/Event" }));
  await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(2));
});

test("deleted or emptied sessions cannot create; contextual List card exposes the same action", async () => {
  render(<ImportSessionSummary id={id} />);
  await screen.findByText(/Folder import/);
  api.getImportSession.mockRejectedValueOnce(new Error("Import Session not found"));
  await userEvent.click(screen.getByRole("button", { name: "Create Trip/Event" }));
  expect((await screen.findByRole("alert")).textContent).toContain("not found");
  api.getImportSession.mockResolvedValueOnce(item).mockResolvedValueOnce({ ...item, active_count: 0 });
  await userEvent.click(screen.getByRole("button", { name: "Create Trip/Event" }));
  const dialog = within(await screen.findByRole("dialog"));
  await userEvent.click(dialog.getByRole("checkbox"));
  await userEvent.click(dialog.getByRole("button", { name: "Create Trip/Event" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("no available photos");
  expect(api.createEvent).not.toHaveBeenCalled();
});

test("empty sessions explain assignment and private labels never become suggested titles", () => {
  render(<ImportSessionCard item={{ ...item, active_count: 0 }} />);
  expect((screen.getByRole("button", { name: "Create Trip/Event" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/no available photos for assignment/)).toBeTruthy();
  for (const label of ["C:\\private\\photos", "/home/private/photos", "https://private.example/", "../secrets", "hidden\nvalue"])
    expect(importSuggestedTitle({ ...item, label })).toBe("");
});

test("addition URL retains valid List filters while removing old Event scope and page", () => {
  const href = importEventAddHref(id, 8, new URLSearchParams("view=trash&catalog_event_id=3&catalog_page=2&catalog_rating=5&catalog_search=bird&smart_edit=3"));
  const params = new URL(href, "http://localhost").searchParams;
  expect(parseCatalogState(params)).toMatchObject({ page: 1, rating: 5, search: "bird", import_session_id: id });
  expect(params.has("catalog_event_id")).toBe(false); expect(params.has("smart_edit")).toBe(false);
  expect(params.has("view")).toBe(false); expect(params.get("add_to_event")).toBe("8");
});

test("navigation failure retains the created Event and continuation link without resubmission", async () => {
  const router = navigation.useRouter();
  const spy = vi.spyOn(navigation, "useRouter").mockReturnValue({ ...router, push: () => { throw new Error("Navigation failed"); } });
  try {
    const dialog = await open();
    await userEvent.click(dialog.getByRole("checkbox"));
    await userEvent.click(dialog.getByRole("button", { name: "Create Trip/Event" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Trip/Event created");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Trip/Event" })).toBeNull();
    expect(screen.getByRole("link", { name: "Continue selecting photos" }).getAttribute("href")).toContain("add_to_event=8");
    expect(api.createEvent).toHaveBeenCalledTimes(1);
    expect(api.addEventPhotos).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); }
});

test("loading retains launcher focus and suppresses duplicate session requests", async () => {
  let resolve!: (value: typeof item) => void;
  api.getImportSession.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<ImportSessionCard item={item} />);
  const launch = screen.getByRole("button", { name: "Create Trip/Event" });
  await userEvent.click(launch);
  expect(launch.getAttribute("aria-disabled")).toBe("true");
  expect((launch as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(launch);
  await userEvent.click(launch);
  expect(api.getImportSession).toHaveBeenCalledTimes(1);
  await act(async () => resolve(item));
  await screen.findByRole("dialog");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(launch));
});
