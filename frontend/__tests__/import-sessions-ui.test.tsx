import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import ImportsBrowser from "../app/imports/imports-browser";
import ImportSessionSummary, { ImportSessionCard } from "../app/components/import-session-summary";
import { parseCatalogState, writeCatalogState } from "../app/lib/catalog-query";
import { importCullHref, importListHref, importRejectedHref } from "../app/lib/import-sessions";
import { savedQueryFromState, smartCollectionEditHref } from "../app/lib/smart-collections";
import { importSessionFixture } from "./fixtures/import-sessions";

const api = vi.hoisted(() => ({ getImportSessions: vi.fn(), getImportSession: vi.fn() }));
vi.mock("../app/lib/api", async (original) => ({ ...await original<typeof import("../app/lib/api")>(), ...api }));
const id = "b0ed3764-5211-4b54-9952-e3f29027dc21";
const item = importSessionFixture(id, { source_kind: "folder_import", label: "Slovenia", imported_count: 3, active_count: 2, trash_count: 1, undecided_count: 0, pick_count: 1, reject_count: 1, completed_at: "2026-10-01T10:01:00Z", duplicate_count: 1, visual_duplicate_skipped_count: 2, unsupported_count: 0, failed_count: 0 });

beforeEach(() => { vi.resetAllMocks(); window.history.replaceState(null, "", "/imports"); });

test("Recent Imports displays provenance, live active-only progress and scoped workflow links", async () => {
  api.getImportSessions.mockResolvedValue({ items: [item], total: 1, page: 1, page_size: 24, total_pages: 1 });
  render(<ImportsBrowser />);
  expect(await screen.findByText("Folder import · Slovenia")).toBeTruthy();
  expect(screen.getByText("3 imported originally · 2 active / 1 in Trash")).toBeTruthy();
  expect(screen.getByText("Active photos: 0 undecided · 1 Pick · 1 Reject")).toBeTruthy();
  expect(screen.getByRole("link", { name: "View imported photos" }).getAttribute("href")).toBe(importListHref(id));
  const destination = new URL(screen.getByRole("link", { name: "Cull this import" }).getAttribute("href")!, "http://localhost");
  expect(destination.searchParams.get("source")).toBe("list");
  expect(destination.searchParams.get("catalog_import_session_id")).toBe(id);
  expect(destination.searchParams.has("catalog_culling_state")).toBe(false);
});

test("empty and unfinished historical sessions have truthful metadata without empty Photo actions", () => {
  render(<ImportSessionCard item={importSessionFixture(id, { imported_count: 4 })} />);
  expect(screen.getByText(/Not finalized/)).toBeTruthy();
  expect(screen.getByText(/4 imported originally/)).toBeTruthy();
  expect(screen.getByText(/not finalized its outcome summary/)).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Cull this import" })).toBeNull();
});

test("session metadata refreshes when the catalog changes", async () => {
  api.getImportSession.mockResolvedValueOnce(item).mockResolvedValueOnce({ ...item, pick_count: 2, reject_count: 0 });
  const view = render(<ImportSessionSummary id={id} revision={1} />);
  await screen.findByText(/1 Pick · 1 Reject/);
  view.rerender(<ImportSessionSummary id={id} revision={2} />);
  await screen.findByText(/2 Pick · 0 Reject/);
  await waitFor(() => expect(api.getImportSession).toHaveBeenCalledTimes(2));
});

test("session criteria restore through List, Culling and Smart Collection edit URLs", () => {
  const state = parseCatalogState(new URLSearchParams(`catalog_import_session_id=${id}&catalog_search=bird&catalog_culling_state=reject`));
  expect(parseCatalogState(writeCatalogState(new URLSearchParams(), state))).toEqual(state);
  const saved = savedQueryFromState(state, "bird");
  expect(saved.import_session_id).toBe(id);
  const restored = new URL(smartCollectionEditHref(3, saved), "http://localhost");
  expect(parseCatalogState(restored.searchParams).import_session_id).toBe(id);
  expect(new URL(importRejectedHref(id), "http://localhost").searchParams.get("catalog_culling_state")).toBe("reject");
  expect(importCullHref(id)).toContain("source=list");
});
