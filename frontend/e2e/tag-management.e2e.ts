import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("archive-wide rename, stale retry, case-sensitive merge and confirmed delete", async ({ page, request }) => {
  const backend = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  const ids: number[] = [];
  const source = "e2e-manage-Bird";
  const destination = "e2e-manage-birds";
  const upper = "e2e-manage-BIRDS";
  try {
    const buffer = await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg"));
    for (let index = 0; index < 3; index++) {
      const response = await request.post(`${backend}/photos/upload`, { multipart: { allow_visual_duplicate: "true", file: { name: `e2e-manage-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([buffer, Buffer.from(`disposable-management-${index}`)]) } } });
      expect(response.ok()).toBe(true);
      const photo = await response.json(); ids.push(photo.id);
      expect((await request.patch(`${backend}/photos/${photo.id}`, { data: { tags: index === 1 ? [source, destination, "e2e-unrelated"] : [source, "e2e-unrelated"], rating: 4, is_favorite: true } })).ok()).toBe(true);
    }
    expect((await request.delete(`${backend}/photos/${ids[2]}`)).ok()).toBe(true);
    await page.goto("/tags");
    await page.getByLabel("Search tags").fill(source);
    const rename = page.getByRole("button", { name: `Rename tag ${source}`, exact: true });
    await rename.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Destination tag", { exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Preview changes", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await dialog.getByLabel("Destination tag", { exact: true }).fill(destination);
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await expect(dialog.getByText("2 active Photos affected", { exact: true })).toBeVisible();
    await expect(dialog.getByText("1 Trashed Photos affected", { exact: true })).toBeVisible();
    await expect(dialog.getByText("1 affected Photos already contain the destination tag", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/This rename will merge/)).toBeVisible();
    await expect(dialog.getByText(/Before:/).first()).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("tag-rename-desktop.png"), fullPage: true });
    // Concurrent edits invalidate the preview before any archive-wide write.
    expect((await request.post(`${backend}/photos/bulk`, { data: { photo_ids: [ids[0]], operation: "add_tags", tags: ["e2e-concurrent"] } })).ok()).toBe(true);
    await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Archive tags changed");
    await expect(dialog.getByRole("button", { name: "Confirm changes", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Retry Preview", exact: true }).click();
    await expect(dialog.getByText("3 total Photos will be updated", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Updated 3 Photos" })).toBeVisible();
    await page.getByLabel("Search tags").fill(destination);
    await expect(page.getByRole("link", { name: `${destination} 2 photos`, exact: true })).toBeVisible();
    expect((await request.post(`${backend}/trash/photos/${ids[2]}/restore`)).ok()).toBe(true);
    const restored = await (await request.get(`${backend}/photos/${ids[2]}`)).json();
    expect(restored.tags).toEqual([destination, "e2e-unrelated"]);
    expect(restored.rating).toBe(4); expect(restored.is_favorite).toBe(true);
    const filtered = await (await request.get(`${backend}/catalog/photos`, { params: { tags: destination } })).json();
    expect(filtered.total).toBe(3);
    expect(filtered.items.every((photo: { tags: string[] }) => photo.tags.filter((tag) => tag === destination).length === 1)).toBe(true);
    expect((await (await request.get(`${backend}/catalog/culling`, { params: { tags: destination } })).json()).total).toBe(3);
    expect((await (await request.get(`${backend}/catalog/photos`, { params: { search: destination } })).json()).total).toBe(3);
    // Existing case variants stay distinct until explicitly merged.
    expect((await request.post(`${backend}/photos/bulk`, { data: { photo_ids: [ids[0]], operation: "add_tags", tags: [upper] } })).ok()).toBe(true);
    await page.reload();
    await page.getByLabel("Search tags").fill(upper);
    await page.getByRole("button", { name: `Merge tag ${upper}`, exact: true }).click();
    await page.getByLabel(/Destination tag/).fill(destination);
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await expect(dialog.getByText("1 total Photos will be updated", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Confirm changes", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByLabel("Search tags").fill(destination);
    await page.setViewportSize({ width: 360, height: 760 });
    const deleteButton = page.getByRole("button", { name: `Delete tag ${destination}`, exact: true });
    await deleteButton.click();
    await page.keyboard.press("Escape");
    await expect(deleteButton).toBeFocused();
    await deleteButton.click();
    await dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    const confirmDelete = dialog.getByRole("button", { name: "Confirm delete tag", exact: true });
    await expect(confirmDelete).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect.poll(() => dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("tag-delete-mobile.png"), fullPage: true });
    await dialog.getByRole("checkbox", { name: /Remove this tag from all/ }).check();
    await confirmDelete.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Deleted tag" })).toBeVisible();
    await expect(page.getByRole("link", { name: `${destination} 3 photos`, exact: true })).toHaveCount(0);
    for (const id of ids) {
      const photo = await (await request.get(`${backend}/photos/${id}`)).json();
      expect(photo.tags).not.toContain(destination); expect(photo.tags).not.toContain(source); expect(photo.tags).not.toContain(upper);
      expect(photo.tags).toContain("e2e-unrelated"); expect(photo.rating).toBe(4);
    }
  } finally {
    for (const id of ids) { await request.delete(`${backend}/photos/${id}`); await request.delete(`${backend}/trash/photos/${id}`); }
  }
});
