import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

test("Daily Calendar: dates, List drill-down, history, corrections, Trash, Restore and mobile keyboard", async ({ page, request }) => {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
  const ids: number[] = [];
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/catalog/")) requests.push(request.url()); });
  try {
    for (let index = 0; index < 4; index++) {
      const response = await request.post(`${backend}/photos/upload`, { multipart: {
        allow_visual_duplicate: "true",
        file: { name: `calendar-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg")), Buffer.from(`calendar-${index}`)]) },
      } });
      expect(response.ok()).toBe(true);
      const photo = await response.json(); ids.push(photo.id);
      const edit = await request.patch(`${backend}/photos/${photo.id}`, { params: { expected_updated_at: photo.updated_at }, data: {
        captured_at: index < 2 ? "2004-02-29T23:59:59" : index === 2 ? "2004-03-01T00:00:00" : "2005-01-01T00:01:00",
        captured_at_offset_minutes: index % 2 ? -720 : 840,
      } });
      expect(edit.ok()).toBe(true);
    }
    const defaultCalendar = await request.get(`${backend}/catalog/calendar`);
    expect(defaultCalendar.ok()).toBe(true);
    const latestYear = (await defaultCalendar.json()).year;
    await page.goto("/timeline");
    await expect(page.getByRole("heading", { name: "2004", exact: true })).toBeVisible();
    expect(requests.some((url) => url.includes("/catalog/calendar"))).toBe(false);
    requests.length = 0;
    await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(page.getByLabel("Capture year")).toHaveValue(String(latestYear));
    await expect(page).toHaveURL(new RegExp(`view=calendar&year=${latestYear}`));
    await page.getByLabel("Capture year").selectOption("2004");
    await expect(page).toHaveURL(/view=calendar&year=2004/);
    const calendar = page.getByRole("region", { name: "Daily photography calendar 2004" });
    await expect(calendar.getByRole("heading", { level: 3 })).toHaveCount(12);
    const day = page.getByRole("link", { name: "29 February 2004: 2 photos", exact: true });
    await expect(day).toBeVisible();
    await expect(page.getByRole("link", { name: "Most active day: 29 February 2004: 2 photos" })).toBeVisible();
    const summary = page.getByLabel("Photography activity summary");
    await expect(summary.getByText("Photos captured this year", { exact: true }).locator("..")).toContainText("3");
    await expect(summary.getByText("Active photography days", { exact: true }).locator("..")).toContainText("2");
    await expect(summary.getByText("Average Photos per active day", { exact: true }).locator("..")).toContainText("1.5");
    expect(requests.some((url) => url.includes("/catalog/timeline"))).toBe(false);
    await page.reload();
    await expect(page.getByLabel("Capture year")).toHaveValue("2004");
    await day.click();
    await expect(page).toHaveURL(/catalog_taken_from=2004-02-29&catalog_taken_to=2004-02-29&catalog_sort=captured_at/);
    await expect(page.getByRole("article")).toHaveCount(2);
    await expect(page.getByRole("article").filter({ hasText: "calendar-0.jpg" })).toHaveCount(1);
    await expect(page.getByRole("article").filter({ hasText: "calendar-1.jpg" })).toHaveCount(1);
    await page.goBack();
    await expect(day).toBeVisible();
    await page.goForward();
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.goBack();
    await page.getByRole("button", { name: "Timeline", exact: true }).click();
    await page.getByRole("button", { name: "Calendar", exact: true }).click();
    await expect(page.getByLabel("Capture year")).toHaveValue("2004");
    expect((await request.delete(`${backend}/photos/${ids[0]}`)).ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("link", { name: "29 February 2004: 1 photo", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Most active day: 29 February 2004: 1 photo" })).toBeVisible();
    expect((await request.post(`${backend}/trash/photos/${ids[0]}/restore`)).ok()).toBe(true);
    await page.reload();
    await expect(day).toBeVisible();
    const photo = await (await request.get(`${backend}/photos/${ids[2]}`)).json();
    const correction = await request.patch(`${backend}/photos/${photo.id}`, { params: { expected_updated_at: photo.updated_at }, data: { captured_at: "2004-02-29T00:01:00", captured_at_offset_minutes: photo.captured_at_offset_minutes } });
    expect(correction.ok(), await correction.text()).toBe(true);
    await page.reload();
    const corrected = page.getByRole("link", { name: "29 February 2004: 3 photos", exact: true });
    await expect(corrected).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("calendar-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("calendar-mobile.png"), fullPage: true });
    await corrected.focus();
    await expect(corrected).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("article")).toHaveCount(3);
  } finally {
    for (const id of ids) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
