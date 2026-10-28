import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("Tag Explorer exact filters, chips, history, bulk tags and mobile keyboard smoke", async ({ page, request }) => {
  const backend = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  const ids: number[] = [];
  const tag = "e2e-tag-birds";
  const sunset = "e2e-tag-sunset";
  try {
    const buffer = await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg"));
    for (let i = 0; i < 3; i++) {
      const upload = await request.post(`${backend}/photos/upload`, { multipart: { allow_visual_duplicate: "true", file: { name: `e2e-tags-${i}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([buffer, Buffer.from(`disposable-tags-${i}`)]) } } });
      expect(upload.ok()).toBe(true);
      const photo = await upload.json();
      ids.push(photo.id);
      expect((await request.patch(`${backend}/photos/${photo.id}`, { data: { tags: i === 0 ? [tag, sunset] : i === 1 ? [tag] : ["e2e-tag-bird"] } })).ok()).toBe(true);
    }
    await page.goto("/tags");
    await expect(page.getByRole("heading", { name: "Tag Explorer" })).toBeVisible();
    await page.getByLabel("Search tags").fill(tag);
    const tagLink = page.getByRole("link", { name: `${tag} 2 photos`, exact: true });
    await expect(tagLink).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("tags-explorer-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("tags-explorer-mobile.png"), fullPage: true });
    await tagLink.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/catalog_tag=e2e-tag-birds/);
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByText(/Version-1 Smart Collections cannot save them/)).toBeVisible();
    await page.getByRole("link", { name: "Open in Culling", exact: true }).click();
    await expect(page).toHaveURL(/cull\?.*catalog_tag=e2e-tag-birds/);
    await page.getByRole("link", { name: "Back to List", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.goto(`/map?catalog_tag=${tag}`);
    await expect(page.getByText(/Exact tag filters are not supported on Map/)).toBeVisible();
    await page.getByRole("link", { name: "View in List", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.getByLabel("Search tag options").fill(sunset);
    await expect(page.getByRole("option", { name: `${sunset} (1)` })).toBeAttached();
    await page.getByLabel("Add exact tag").selectOption(sunset);
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.getByRole("button", { name: `Remove tag ${sunset}` }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.goBack();
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.goForward();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole("button", { name: `Remove tag ${tag}` })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("tags-mobile.png"), fullPage: true });
    // Existing bulk mutations stay explicit and update aggregation immediately.
    expect((await request.post(`${backend}/photos/bulk`, { data: { photo_ids: [ids[1]], operation: "add_tags", tags: [sunset] } })).ok()).toBe(true);
    expect((await request.get(`${backend}/catalog/photos`, { params: { tags: sunset } })).ok()).toBe(true);
    expect((await request.post(`${backend}/photos/bulk`, { data: { photo_ids: [ids[1]], operation: "remove_tags", tags: [sunset] } })).ok()).toBe(true);
    await page.getByRole("button", { name: "Clear tag filters" }).click();
    await expect(page).not.toHaveURL(/catalog_tag=/);
    await page.getByLabel("Photos without tags", { exact: true }).focus();
    await page.keyboard.press("Space");
    await expect(page.getByLabel("Photos without tags", { exact: true })).toBeChecked();
    await expect(page).toHaveURL(/catalog_untagged=1/);
    await page.getByRole("button", { name: "Clear tag filters" }).click();
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("e2e-tags-0");
    await expect(page.getByRole("article")).toHaveCount(1);
  } finally {
    for (const id of ids) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
