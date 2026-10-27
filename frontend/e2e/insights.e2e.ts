import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("Insights aggregates, period drill-down, restore and mobile charts", async ({ page, request }) => {
  const backend = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  let id: number | undefined;
  try {
    const upload = await request.post(`${backend}/photos/upload`, {
      multipart: {
        allow_visual_duplicate: "true",
        file: { name: "faunavault-e2e-insights.jpg", mimeType: "image/jpeg", buffer: Buffer.concat([await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg")), Buffer.from("insights-disposable-fixture")]) },
      },
    });
    expect(upload.ok()).toBe(true);
    const photo = await upload.json();
    id = photo.id;
    const edit = await request.patch(`${backend}/photos/${id}`, { params: { expected_updated_at: photo.updated_at }, data: {
      captured_at: "2004-02-29T23:30:00", captured_at_offset_minutes: 120,
      latitude: 0, longitude: 0, category: "bird", is_favorite: true, culling_state: "pick",
    } });
    expect(edit.ok()).toBe(true);
    await page.goto("/insights?year=2004");
    await expect(page.getByRole("heading", { name: "Wildlife Insights" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^February/ })).toContainText("1 photo");
    await expect(page.getByRole("link", { name: /^January/ })).toContainText("0 photos");
    await expect(page.getByRole("region", { name: "Geographic coverage" })).toContainText("100%");
    await expect(page.getByText("No verified species in this period.")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("insights-desktop.png"), fullPage: true });
    await page.getByRole("link", { name: /^February/ }).click();
    await expect(page).toHaveURL(/catalog_taken_from=2004-02-01.*catalog_taken_to=2004-02-29/);
    await expect(page.getByRole("article").filter({ hasText: "faunavault-e2e-insights.jpg" })).toHaveCount(1);
    await page.getByRole("navigation", { name: "Archive views" }).getByRole("link", { name: "Insights", exact: true }).click();
    await page.getByLabel("Capture year").selectOption("2004");
    await expect(page).toHaveURL(/insights\?year=2004/);
    await page.reload();
    await expect(page.getByLabel("Capture year")).toHaveValue("2004");
    await page.setViewportSize({ width: 360, height: 760 });
    await expect(page.getByRole("link", { name: /^February/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("insights-mobile.png"), fullPage: true });
    const month = page.getByRole("link", { name: /^February/ });
    await month.focus();
    await expect(month).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/catalog_taken_from=2004-02-01/);
    expect((await request.delete(`${backend}/photos/${id}`)).ok()).toBe(true);
    await page.goto("/insights?year=2004");
    await expect(page.getByText("No active photos in this year")).toBeVisible();
    expect((await request.post(`${backend}/trash/photos/${id}/restore`)).ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("link", { name: /^February/ })).toContainText("1 photo");
  } finally {
    if (id) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
