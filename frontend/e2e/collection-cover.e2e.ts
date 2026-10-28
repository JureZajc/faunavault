import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`Collection cover ${viewport.name}: persist, fallback, restore and remove`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Use npm run test:e2e for disposable archive storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const token = randomUUID(), ids: number[] = [], names: string[] = [], thumbnails: string[] = [];
    let collectionId: number | null = null;
    try {
      for (const suffix of ["chosen", "automatic"]) {
        const name = `cover-${viewport.name}-${suffix}.jpg`;
        const response = await request.post(`${backend}/photos/upload`, { multipart: {
          allow_visual_duplicate: "true",
          file: { name, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`${token}-${suffix}`)]) },
        } });
        expect(response.ok()).toBe(true);
        const photo = await response.json();
        ids.push(photo.id); names.push(name); thumbnails.push(photo.thumbnail_filename);
      }
      const created = await request.post(`${backend}/collections`, { data: {
        name: `Cover collection ${viewport.name}`,
      } });
      expect(created.ok()).toBe(true);
      collectionId = (await created.json()).id;
      expect((await request.post(`${backend}/collections/${collectionId}/photos`, { data: { photo_ids: ids } })).ok()).toBe(true);
      await page.goto(`/collections/${collectionId}`);
      const header = page.getByRole("region", { name: "Collection cover" });
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[1]));
      const set = page.getByRole("button", { name: `Set as cover: ${names[0]}`, exact: true });
      await set.focus(); await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "Custom cover saved." })).toBeVisible();
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[0]));
      await page.reload();
      await expect(page.getByRole("button", { name: `Current cover: ${names[0]}` })).toBeDisabled();
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[0]));
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`collection-cover-${viewport.name}.png`), fullPage: true });

      await page.goto("/collections");
      const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: `Cover collection ${viewport.name}` }) });
      await expect(card.getByRole("region", { name: "Collection cover" }).getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[0]));
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`collection-cover-list-${viewport.name}.png`), fullPage: true });

      expect((await request.delete(`${backend}/photos/${ids[0]}`)).ok()).toBe(true);
      await page.goto(`/collections/${collectionId}`);
      await expect(page.getByText(/Custom cover is in Trash/)).toBeVisible();
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[1]));
      expect((await request.post(`${backend}/trash/photos/${ids[0]}/restore`)).ok()).toBe(true);
      await page.reload();
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[0]));
      await page.getByRole("button", { name: "Remove custom cover", exact: true }).click();
      await expect(page.getByText("Automatic cover", { exact: true })).toBeVisible();
      await page.reload();
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[1]));
      expect((await (await request.get(`${backend}/collections/${collectionId}`)).json()).cover_photo_id).toBeNull();
      await page.getByRole("button", { name: `Set as cover: ${names[0]}`, exact: true }).click();
      await expect(page.getByRole("button", { name: `Current cover: ${names[0]}` })).toBeDisabled();
      expect((await request.delete(`${backend}/collections/${collectionId}/photos`, { data: { photo_ids: [ids[0]] } })).ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole("button", { name: "Remove custom cover", exact: true })).toBeDisabled();
      await expect(header.getByRole("img")).toHaveAttribute("src", new RegExp(thumbnails[1]));
      expect((await request.delete(`${backend}/collections/${collectionId}/photos`, { data: { photo_ids: [ids[1]] } })).ok()).toBe(true);
      await page.reload();
      await expect(header.getByText("No active Photos for a cover")).toBeVisible();
    } finally {
      if (collectionId) await request.delete(`${backend}/collections/${collectionId}`);
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
}
