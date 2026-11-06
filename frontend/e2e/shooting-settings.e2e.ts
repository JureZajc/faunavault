import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("displays imported shooting settings and keeps List ranges in browser history", async ({ page, request }) => {
  const backend = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  const names = ["telephoto", "wide", "long"].map((name) => `faunavault-e2e-shooting-${name}.jpg`);
  const ids: number[] = [];
  try {
    for (const name of names) {
      const buffer = await readFile(path.join(root, "fixtures", name));
      const response = await request.post(`${backend}/photos/upload`, {
        multipart: { allow_visual_duplicate: "true", file: { name, mimeType: "image/jpeg", buffer } },
      });
      expect(response.ok(), await response.text()).toBe(true);
      ids.push((await response.json()).id);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const cards = page.getByRole("article").filter({ hasText: /faunavault-e2e-shooting-/ });
    await expect(cards).toHaveCount(3);
    await cards.getByText(names[0], { exact: true }).click();
    const settings = page.getByRole("region", { name: "Shooting Settings" });
    await expect(settings.getByText(/^f\/5[.,]6$/)).toBeVisible();
    await expect(settings.getByText("1/2000 s", { exact: true })).toBeVisible();
    await expect(settings.getByText("1600", { exact: true })).toBeVisible();
    await expect(settings.getByText("400 mm", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Back to catalog" }).click();
    await expect(cards).toHaveCount(3);

    await page.getByText("Shooting Settings filters", { exact: true }).click();
    await page.getByRole("textbox", { name: "Minimum ISO" }).fill("1200");
    await page.getByRole("textbox", { name: "Maximum ISO" }).fill("1600");
    await page.getByRole("textbox", { name: "Minimum Focal length (mm)" }).fill("300");
    await page.getByRole("textbox", { name: "Maximum Focal length (mm)" }).fill("400");
    await page.getByRole("button", { name: "Apply shooting filters" }).click();
    await expect(page).toHaveURL(/catalog_iso_speed_min=1200/);
    await expect(cards).toHaveCount(1);
    await expect(cards.getByText(names[0], { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save as Smart Collection" })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.reload();
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Maximum Focal length (mm)" })).toHaveValue("400");
    await page.goBack();
    await expect(cards).toHaveCount(3);
    await page.goForward();
    await expect(cards).toHaveCount(1);
    await page.getByRole("button", { name: "Clear shooting filters" }).click();
    await expect(cards).toHaveCount(3);
    await expect(page).not.toHaveURL(/catalog_(iso_speed|focal_length)/);
  } finally {
    for (const id of ids) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
