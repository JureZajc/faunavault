import type { ImportSession } from "../../app/lib/api";

export function importSessionFixture(id: string, overrides: Partial<ImportSession> = {}): ImportSession {
  return { id, source_kind: "browser_upload", label: null, started_at: "2026-10-01T10:00:00Z", completed_at: null,
    imported_count: 0, duplicate_count: null, visual_duplicate_skipped_count: null, unsupported_count: null, failed_count: null,
    active_count: 0, trash_count: 0, undecided_count: 0, pick_count: 0, reject_count: 0, ...overrides };
}
