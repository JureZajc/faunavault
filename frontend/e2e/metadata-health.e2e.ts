import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`metadata health ${viewport.name}: find, correct, and return to filtered Photos`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const ids: number[] = [];
    try {
      const response = await request.post(`${backend}/photos/upload`, { multipart: {
        allow_visual_duplicate: "true",
        file: { name: `metadata-health-${viewport.name}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`health-${viewport.name}`)]) },
      } });
      expect(response.ok()).toBe(true);
      const photo = await response.json(); ids.push(photo.id);
      const cleared = await request.patch(`${backend}/photos/${photo.id}?expected_updated_at=${encodeURIComponent(photo.updated_at)}`, { data: { captured_at: null, captured_at_offset_minutes: null, latitude: null, longitude: null } });
      expect(cleared.ok(), await cleared.text()).toBe(true);
      await page.goto("/metadata-health");
      await expect(page.getByRole("heading", { name: "Metadata Health", exact: true })).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "Metadata completeness" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`metadata-health-${viewport.name}.png`), fullPage: true });
      const counts = page.getByLabel("Metadata health counts");
      await counts.getByRole("link", { name: "Missing GPS", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Metadata completeness", exact: true })).toHaveValue("missing_gps");
      await page.getByRole("searchbox", { name: "Search", exact: true }).fill(`metadata-health-${viewport.name}`);
      const card = page.locator("article").filter({ hasText: `metadata-health-${viewport.name}.jpg` });
      await expect(card).toHaveCount(1);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await card.getByRole("link").first().click();
      await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
      await page.getByLabel("Latitude", { exact: true }).fill("0");
      await page.getByLabel("Longitude", { exact: true }).fill("0");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit metadata", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await expect(page.getByRole("combobox", { name: "Metadata completeness", exact: true })).toHaveValue("missing_gps");
      await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
      await page.getByRole("combobox", { name: "Metadata completeness", exact: true }).selectOption("missing_capture");
      await expect(card).toHaveCount(1);
      await card.getByRole("link").first().click();
      await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
      await page.getByLabel("Capture date/time", { exact: true }).fill("2026-05-02T12:00");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit metadata", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await expect(page.getByRole("combobox", { name: "Metadata completeness", exact: true })).toHaveValue("missing_capture");
      await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
      const persisted = await (await request.get(`${backend}/photos/${photo.id}`)).json();
      expect(persisted).toMatchObject({ latitude: 0, longitude: 0, captured_at: "2026-05-02T12:00:00" });
      await page.goto("/metadata-health");
      const health = await (await request.get(`${backend}/catalog/metadata-health`)).json();
      await expect(page.getByRole("progressbar")).toHaveAttribute("value", String(health.completeness_percentage));
    } finally {
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
}
