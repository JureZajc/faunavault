import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("Gear Explorer exact camera/lens navigation, partial EXIF, history and mobile", async ({ page, request }) => {
  const backend = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  const ids: number[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const buffer = await readFile(path.join(root, "fixtures", `faunavault-e2e-gear-${i}.jpg`));
      const response = await request.post(`${backend}/photos/upload`, { multipart: { allow_visual_duplicate: "true", file: { name: `e2e-gear-${i}.jpg`, mimeType: "image/jpeg", buffer } } });
      expect(response.ok()).toBe(true);
      ids.push((await response.json()).id);
    }
    await page.goto("/gear");
    await expect(page.getByRole("heading", { name: "Camera & Lens Explorer" })).toBeVisible();
    await page.getByLabel("Search cameras and lenses").fill("E2E Canon");
    const camera = page.getByRole("region", { name: "Cameras" }).getByRole("link", { name: /^E2E Canon EOS R5 2 Photos/ });
    await expect(camera).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("gear-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("gear-mobile.png"), fullPage: true });
    await camera.focus(); await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/catalog_camera_model=E2E\+Canon\+EOS\+R5/);
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByText(/Equipment filters cannot be saved in version-1 Smart Collections/)).toBeVisible();
    await expect(page.getByRole("button", { name: "View on Map", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "Map", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "equipment filters" })).toBeVisible();
    await page.getByRole("combobox", { name: "Lens model", exact: true }).focus();
    await page.getByRole("combobox", { name: "Lens model", exact: true }).selectOption(JSON.stringify("E2E RF100-500mm"));
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.goBack(); await expect(page.getByRole("article")).toHaveCount(2);
    await page.goForward(); await expect(page.getByRole("article")).toHaveCount(1);
    await page.reload(); await expect(page.getByRole("article")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("gear-list-mobile.png"), fullPage: true });
    await page.getByRole("link", { name: "Open in Culling", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 matching photos" })).toBeVisible();
    await page.getByRole("link", { name: "Back to List", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.goto("/gear");
    await page.getByRole("region", { name: "Lenses" }).getByRole("link", { name: /^E2E RF100-500mm 2 Photos/ }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.goto("/gear");
    await page.getByRole("link", { name: /Photos without camera information/ }).click();
    await expect(page).toHaveURL(/catalog_unknown_camera=1/);
    const unknown = await request.get(`${backend}/catalog/photos?unknown_camera=true`);
    const unknownPhotos = (await unknown.json()).items;
    expect(unknownPhotos.some((photo: { id: number }) => photo.id === ids[4])).toBe(true);
    expect(unknownPhotos.some((photo: { id: number }) => photo.id === ids[3])).toBe(false);
    await page.goto("/gear");
    const partial = page.getByRole("region", { name: "Cameras" }).getByRole("link", { name: /^E2E Canon 1 Photos/ });
    await partial.click();
    await expect(page).toHaveURL(/catalog_camera_model=(?:&|$)/);
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.getByRole("button", { name: "Clear equipment filters" }).click();
    await expect(page).not.toHaveURL(/catalog_camera/);
    await page.goto("/map?catalog_lens_model=E2E+RF100-500mm");
    await expect(page.getByText(/Equipment filters are not supported on Map/)).toBeVisible();
    await page.getByRole("link", { name: "View in List", exact: true }).click();
    await expect(page.getByRole("article")).toHaveCount(2);
  } finally {
    for (const id of ids) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
