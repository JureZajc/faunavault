import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const backend = "http://127.0.0.1:8001";

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`bulk capture metadata ${viewport.name}: preview, confirmation, conflict and refresh`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const ids: number[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const response = await request.post(`${backend}/photos/upload`, { multipart: {
          allow_visual_duplicate: "true",
          file: { name: `bulk-capture-${viewport.name}-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`bulk-capture-${viewport.name}-${index}`)]) },
        } });
        expect(response.ok()).toBe(true);
        ids.push((await response.json()).id);
      }
      await page.goto(`/?catalog_search=bulk-capture-${viewport.name}`);
      await page.getByRole("button", { name: "Select photos", exact: true }).click();
      for (const id of ids) await page.getByRole("checkbox", { name: new RegExp(`Select photo ${id}:`) }).check();
      const launch = page.getByRole("button", { name: "Edit capture / GPS" });
      await launch.click();
      let dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Operation")).toBeFocused();
      await dialog.getByLabel("Operation").press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Preview changes" })).toBeFocused();
      await dialog.press("Escape");
      await expect(launch).toBeFocused();
      await launch.click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Operation").selectOption("set_capture");
      await dialog.getByLabel("Camera-local date and time").fill("2024-02-29T23:30:00");
      await dialog.getByLabel("UTC offset handling").selectOption("unknown");
      await dialog.getByRole("button", { name: "Preview changes" }).click();
      await expect(dialog.getByRole("table")).toBeVisible();
      await expect(dialog.getByRole("heading", { level: 3 })).toContainText("2 selected, 2 affected, 0 cannot");
      await expect(dialog.getByRole("button", { name: "Apply changes" })).toBeDisabled();
      const before = await (await request.get(`${backend}/photos/${ids[0]}`)).json();
      expect(before.captured_at).not.toBe("2024-02-29T23:30:00");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      if (viewport.name === "mobile") {
        const tableRegion = dialog.getByRole("region", { name: "Before and after metadata" });
        await tableRegion.focus();
        await tableRegion.press("ArrowRight");
        await expect.poll(() => tableRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      }
      await page.screenshot({ path: test.info().outputPath(`bulk-capture-${viewport.name}.png`) });
      await dialog.getByRole("checkbox", { name: /I reviewed/ }).check();
      await dialog.getByRole("button", { name: "Apply changes" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Updated capture / GPS metadata for 2 photos." })).toBeVisible();
      await expect(dialog).toHaveCount(0);
      for (const id of ids) {
        const photo = await (await request.get(`${backend}/photos/${id}`)).json();
        expect(photo).toMatchObject({ captured_at: "2024-02-29T23:30:00", captured_at_offset_minutes: null, capture_metadata_overridden: true });
      }

      await page.getByRole("button", { name: "Select photos", exact: true }).click();
      for (const id of ids) await page.getByRole("checkbox", { name: new RegExp(`Select photo ${id}:`) }).check();
      await launch.click();
      dialog = page.getByRole("dialog");
      await dialog.getByLabel("Signed minutes").fill("60");
      await dialog.getByRole("button", { name: "Preview changes" }).click();
      await expect(dialog.getByRole("table")).toContainText("2024-03-01 00:30:00");
      await dialog.getByRole("checkbox", { name: /I reviewed/ }).check();
      // Another tab / worker changes one photo after preview.
      expect((await request.patch(`${backend}/photos/${ids[1]}`, { data: { is_favorite: true } })).ok()).toBe(true);
      await dialog.getByRole("button", { name: "Apply changes" }).click();
      await expect(dialog.getByRole("alert")).toContainText("changed since preview");
      await expect(dialog.getByRole("table")).toHaveCount(0);
      await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
      expect((await (await request.get(`${backend}/photos/${ids[0]}`)).json()).captured_at).toBe("2024-02-29T23:30:00");
      await dialog.getByRole("button", { name: "Preview changes" }).click();
      await dialog.getByRole("checkbox", { name: /I reviewed/ }).check();
      await dialog.getByRole("button", { name: "Apply changes" }).click();
      await expect(dialog).toHaveCount(0);
      await page.goto("/timeline");
      await expect(page.getByRole("link", { name: "View 2 photos from March 2024" })).toBeVisible();
      await page.goto(`/photos/${ids[0]}`);
      await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
      await expect(page.getByLabel("Capture date/time")).toHaveValue("2024-03-01T00:30");
      await expect(page.getByLabel("UTC offset", { exact: true })).toHaveValue("");
    } finally {
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
}
