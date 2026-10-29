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

test("Insights equipment, explicit year comparison, exact List drill-down and history", async ({ page, request }) => {
  const backend = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8001";
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  const ids: number[] = [];
  try {
    for (let index = 0; index < 6; index++) {
      const upload = await request.post(`${backend}/photos/upload`, { multipart: {
        allow_visual_duplicate: "true",
        file: { name: `insights-v2-${index}.jpg`, mimeType: "image/jpeg", buffer: await readFile(path.join(root, "fixtures", index === 5 ? "faunavault-e2e-insights-long.jpg" : `faunavault-e2e-gear-${index}.jpg`)) },
      } });
      expect(upload.ok()).toBe(true);
      const photo = await upload.json();
      ids.push(photo.id);
      const edit = await request.patch(`${backend}/photos/${photo.id}`, { params: { expected_updated_at: photo.updated_at }, data: {
        captured_at: index === 2 ? "2005-01-01T00:01:00" : "2004-02-29T23:59:00",
        captured_at_offset_minutes: index === 2 ? 840 : -720,
        is_favorite: index === 0, culling_state: index < 2 ? "pick" : index < 4 ? "reject" : null,
        latitude: index === 0 || index === 2 ? 0 : null,
        longitude: index === 0 || index === 2 ? 0 : null,
      } });
      expect(edit.ok()).toBe(true);
    }
    await page.goto("/insights");
    await expect(page.getByLabel("Compare with")).toBeDisabled();
    await page.getByLabel("Capture year").selectOption("2004");
    const cameras = page.getByRole("region", { name: "Top Cameras" });
    const camera = cameras.getByRole("link", { name: /^E2E Canon EOS R5/ });
    await expect(camera).toContainText("2 photos40%");
    await expect(page.getByRole("region", { name: "Top Lenses" }).getByRole("link", { name: /^E2E RF100-500mm 1 photo/ })).toContainText("20%");
    const coverage = page.getByRole("region", { name: "Equipment coverage" });
    await expect(coverage).toContainText("4 photos · 80%");
    await expect(coverage).toContainText("1 photo · 20%");
    await page.getByLabel("Compare with").selectOption("2005");
    await expect(page).toHaveURL(/insights\?year=2004&compare=2005/);
    const comparison = page.getByRole("region", { name: "Year comparison" });
    const metric = (name: string) => comparison.getByText(name, { exact: true }).locator("..");
    await expect(metric("Active photos")).toContainText("2004: 5");
    await expect(metric("Active photos")).toContainText("2005: 1");
    await expect(metric("Active photos")).toContainText("+4 (+400%)");
    await expect(metric("Favorite photos")).toContainText("+1 (N/A — zero baseline)");
    await expect(metric("Pick photos")).toContainText("+2 (N/A — zero baseline)");
    await expect(metric("Reject photos")).toContainText("0 (0%)");
    await expect(metric("GPS coverage")).toContainText("-80 percentage points");
    await page.reload();
    await expect(page.getByLabel("Compare with")).toHaveValue("2005");
    await expect(metric("Active photos")).toContainText("+4 (+400%)");
    await page.screenshot({ path: test.info().outputPath("insights-v2-desktop.png"), fullPage: true });
    await camera.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/catalog_camera_make=E2E\+Canon.*catalog_camera_model=E2E\+Canon\+EOS\+R5.*catalog_taken_from=2004-01-01.*catalog_taken_to=2004-12-31/);
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByRole("article").filter({ hasText: "insights-v2-0.jpg" })).toHaveCount(1);
    await expect(page.getByRole("article").filter({ hasText: "insights-v2-1.jpg" })).toHaveCount(1);
    await page.goBack();
    await expect(page.getByLabel("Capture year")).toHaveValue("2004");
    await expect(page.getByLabel("Compare with")).toHaveValue("2005");
    await page.goForward();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.goBack();
    await page.setViewportSize({ width: 360, height: 760 });
    await expect(metric("GPS coverage")).toContainText("-80 percentage points");
    await expect(cameras.getByRole("link", { name: /^E2E Insights LongCamera/ })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("insights-v2-mobile.png"), fullPage: true });
    const unknown = page.getByRole("link", { name: "Without identifiable camera information", exact: true });
    await unknown.focus();
    await expect(unknown).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/catalog_unknown_camera=1.*catalog_taken_from=2004-01-01/);
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article")).toContainText("insights-v2-4.jpg");
  } finally {
    for (const id of ids) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
