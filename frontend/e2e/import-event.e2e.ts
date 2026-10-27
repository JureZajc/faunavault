import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { backend } from "./urls";

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`Import Session to Trip/Event ${viewport.name}: review, create, select and confirm`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Use npm run test:e2e for disposable archive storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const sessionId = randomUUID(), ids: number[] = [];
    let eventId: number | null = null;
    try {
      expect((await request.post(`${backend}/import-sessions`, { data: { id: sessionId } })).ok()).toBe(true);
      for (let index = 0; index < 3; index++) {
        const response = await request.post(`${backend}/photos/upload`, { multipart: {
          import_session_id: sessionId, allow_visual_duplicate: "true",
          file: { name: `import-event-${viewport.name}-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`${sessionId}-${index}`)]) },
        } });
        expect(response.ok()).toBe(true);
        const photo = await response.json(); ids.push(photo.id);
        expect((await request.patch(`${backend}/photos/${photo.id}`, { params: { expected_updated_at: photo.updated_at }, data: {
          captured_at: index === 2 ? null : `2026-08-${index === 0 ? "12" : "17"}T${index === 0 ? "00:15:00" : "23:45:00"}`,
          captured_at_offset_minutes: index === 2 ? null : index === 0 ? 840 : -720,
          is_favorite: true, rating: 4, culling_state: "pick",
        } })).ok()).toBe(true);
      }
      expect((await request.post(`${backend}/import-sessions/${sessionId}/complete`, { data: {
        duplicate_count: 0, visual_duplicate_skipped_count: 0, unsupported_count: 0, failed_count: 0,
      } })).ok()).toBe(true);
      await page.goto("/imports");
      const card = page.getByRole("region", { name: "Import Session", exact: true }).filter({ has: page.locator(`a[href*="${sessionId}"]`) });
      const launch = card.getByRole("button", { name: "Create Trip/Event" });
      await launch.click();
      let form = page.getByRole("dialog");
      await expect(form.getByLabel("Title", { exact: true })).toBeFocused();
      await expect(form.getByLabel("Start date")).toHaveValue("2026-08-12");
      await expect(form.getByLabel("End date")).toHaveValue("2026-08-17");
      await expect(form).toContainText("2 active photos have capture dates; 1 have unknown dates");
      await form.getByRole("combobox", { name: "Type", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(form.getByRole("button", { name: "Create Trip/Event" })).toBeFocused();
      await form.press("Escape");
      await expect(launch).toBeFocused();
      await launch.click(); form = page.getByRole("dialog");
      await form.getByLabel("Title", { exact: true }).fill(`Import trip ${viewport.name}`);
      await form.getByLabel("End date").fill("2026-08-18");
      await form.getByRole("checkbox", { name: /reviewed and accept/ }).check();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`import-event-form-${viewport.name}.png`) });
      await form.getByRole("button", { name: "Create Trip/Event" }).click();
      await expect(page).toHaveURL(new RegExp(`catalog_import_session_id=${sessionId}.*add_to_event=\\d+`));
      eventId = Number(new URL(page.url()).searchParams.get("add_to_event"));
      expect((await (await request.get(`${backend}/events/${eventId}`)).json()).active_photo_count).toBe(0);
      await expect(page.getByRole("heading", { name: `Add Photos to Trip: Import trip ${viewport.name}` })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /Select photo/ })).toHaveCount(0);
      await page.getByRole("button", { name: "Select Photos to add" }).click();
      // Canceling selection preserves the newly created, empty Event.
      await page.getByRole("button", { name: "Exit selection" }).click();
      expect((await (await request.get(`${backend}/events/${eventId}`)).json()).active_photo_count).toBe(0);
      await page.getByRole("button", { name: "Select Photos to add" }).click();
      await page.getByRole("checkbox", { name: new RegExp(`Select photo ${ids[0]}:`) }).check();
      await page.getByRole("button", { name: "Add selected to this Trip" }).click();
      const confirmation = page.getByRole("dialog");
      await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
      expect((await (await request.get(`${backend}/events/${eventId}`)).json()).active_photo_count).toBe(0);
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Add selected to this Trip" }).click();
      await page.getByRole("button", { name: "Confirm add photos" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Added 1 Photos" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Trip/Event", exact: true })).toHaveAttribute("href", `/events/${eventId}`);
      expect(new URL(page.url()).searchParams.get("catalog_import_session_id")).toBe(sessionId);
      const members = await (await request.get(`${backend}/catalog/photos`, { params: { event_id: eventId } })).json();
      expect(members.items.map((photo: { id: number }) => photo.id)).toEqual([ids[0]]);
      for (const id of ids) {
        expect(await (await request.get(`${backend}/photos/${id}`)).json()).toMatchObject({ import_session_id: sessionId, is_favorite: true, rating: 4, culling_state: "pick", status: "pending" });
      }
      await page.screenshot({ path: test.info().outputPath(`import-event-list-${viewport.name}.png`), fullPage: true });
      await page.getByRole("link", { name: "Recent Imports", exact: true }).first().click();
      await expect(page.getByRole("heading", { name: "Recent Imports" })).toBeVisible();
      expect((await (await request.get(`${backend}/events/${eventId}`)).json()).active_photo_count).toBe(1);
    } finally {
      if (eventId) await request.delete(`${backend}/events/${eventId}`);
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
}
