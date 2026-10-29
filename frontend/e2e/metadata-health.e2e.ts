import { expect, type Page, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

async function openFilteredPhoto(page: Page, photoId: number, search: string, issue: "missing_gps" | "missing_capture") {
  // A target card can already exist in the unfiltered results. Wait for the
  // debounced search AND the rendered return link, rather than just that card.
  await expect(page).toHaveURL((url) => url.searchParams.get("catalog_search") === search
    && url.searchParams.get("catalog_metadata_issue") === issue);
  await expect(page.getByRole("article")).toHaveCount(1);
  const card = page.getByRole("article").filter({ hasText: `${search}.jpg` });
  await expect(card).toHaveCount(1);
  const url = new URL(page.url());
  const returnTo = `${url.pathname}${url.search}`;
  const link = card.getByRole("link").first();
  await expect(link).toHaveAttribute("href", `/photos/${photoId}?returnTo=${encodeURIComponent(returnTo)}`);
  await link.click();
  await expect(page.getByRole("link", { name: "Back to catalog" })).toHaveAttribute("href", returnTo);
  return url.href;
}

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`metadata health ${viewport.name}: find, correct, and return to filtered Photos`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const ids: number[] = [];
    const search = `metadata-health-${viewport.name}`;
    try {
      // Keep an unrelated incomplete Photo active: losing the search scope must
      // fail this journey even when it runs alone in an otherwise empty archive.
      for (const filename of [`${search}.jpg`, `unrelated-health-${viewport.name}.jpg`]) {
        const response = await request.post(`${backend}/photos/upload`, { multipart: {
          allow_visual_duplicate: "true",
          file: { name: filename, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(filename)]) },
        } });
        expect(response.ok()).toBe(true);
        const photo = await response.json(); ids.push(photo.id);
        const cleared = await request.patch(`${backend}/photos/${photo.id}?expected_updated_at=${encodeURIComponent(photo.updated_at)}`, { data: { captured_at: null, captured_at_offset_minutes: null, latitude: null, longitude: null } });
        expect(cleared.ok(), await cleared.text()).toBe(true);
      }
      await page.goto("/metadata-health");
      await expect(page.getByRole("heading", { name: "Metadata Health", exact: true })).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "Metadata completeness" })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`metadata-health-${viewport.name}.png`), fullPage: true });
      const counts = page.getByLabel("Metadata health counts");
      await counts.getByRole("link", { name: "Missing GPS", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Metadata completeness", exact: true })).toHaveValue("missing_gps");
      await page.getByRole("searchbox", { name: "Search", exact: true }).fill(search);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const gpsCatalogUrl = await openFilteredPhoto(page, ids[0], search, "missing_gps");
      await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
      await page.getByLabel("Latitude", { exact: true }).fill("0");
      await page.getByLabel("Longitude", { exact: true }).fill("0");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit metadata", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await expect(page).toHaveURL(gpsCatalogUrl);
      await expect(page.getByRole("combobox", { name: "Metadata completeness", exact: true })).toHaveValue("missing_gps");
      await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
      await page.getByRole("combobox", { name: "Metadata completeness", exact: true }).selectOption("missing_capture");
      const captureCatalogUrl = await openFilteredPhoto(page, ids[0], search, "missing_capture");
      await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
      await page.getByLabel("Capture date/time", { exact: true }).fill("2026-05-02T12:00");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit metadata", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await expect(page).toHaveURL(captureCatalogUrl);
      await expect(page.getByRole("combobox", { name: "Metadata completeness", exact: true })).toHaveValue("missing_capture");
      await expect(page.getByText("No matching records", { exact: true })).toBeVisible();
      const persisted = await (await request.get(`${backend}/photos/${ids[0]}`)).json();
      expect(persisted).toMatchObject({ latitude: 0, longitude: 0, captured_at: "2026-05-02T12:00:00" });
      const unrelated = await (await request.get(`${backend}/photos/${ids[1]}`)).json();
      expect(unrelated).toMatchObject({ deleted_at: null, latitude: null, longitude: null, captured_at: null });
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
