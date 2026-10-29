import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

const TRANSPARENT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=", "base64");

for (const mobile of [false, true]) {
  test.describe(mobile ? "Touch device" : "Desktop", () => {
  test.use(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
  test(`Map area: ${mobile ? "mobile taps and keyboard coordinates" : "desktop drag"}, List round-trip, history, reload and clear`, async ({ page, request }, testInfo) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
    const ids: number[] = [];
    const captureDate = mobile ? "2003-04-06" : "2003-04-05";
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg"));
    const selectedName = `area-${mobile}-0.jpg`;
    try {
      for (let index = 0; index < 3; index++) {
        const upload = await request.post(`${backend}/photos/upload`, { multipart: { allow_visual_duplicate: "true",
          file: { name: `area-${mobile}-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`area-${mobile}-${index}`)]) } } });
        expect(upload.ok(), await upload.text()).toBe(true);
        const photo = await upload.json(); ids.push(photo.id);
        const edit = await request.patch(`${backend}/photos/${photo.id}`, { params: { expected_updated_at: photo.updated_at }, data: {
          latitude: index < 2 ? 45 + index * 0.1 : -40, longitude: index < 2 ? 14 + index * 0.1 : -120,
          captured_at: `${captureDate}T12:00:00`, captured_at_offset_minutes: null,
        } });
        expect(edit.ok(), await edit.text()).toBe(true);
      }
      // Scope synthetic records using a supported filter to avoid other journeys.
      await page.goto(`/map?catalog_taken_from=${captureDate}&catalog_taken_to=${captureDate}`);
      await expect(page.getByText("3 mapped photos", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Select area", exact: true }).click();
      const map = page.getByRole("region", { name: /Interactive archive map/ }).locator(".leaflet-container");
      await expect(map).toBeVisible();
      await map.scrollIntoViewIfNeeded();
      await expect(map).not.toHaveClass(/leaflet-zoom-anim/);
      const size = await map.boundingBox();
      if (!size) throw new Error("Map bounds are missing");
      // Use the rendered two-Photo cluster to locate deterministic corners;
      // this stays independent of tiles and viewport-specific map zoom levels.
      const cluster = map.locator(".marker-cluster").filter({ hasText: "2" });
      await expect(cluster).toBeVisible();
      const clusterBox = await cluster.boundingBox();
      if (!clusterBox) throw new Error("Expected the two-Photo cluster");
      const center = { x: clusterBox.x - size.x + clusterBox.width / 2, y: clusterBox.y - size.y + clusterBox.height / 2 };
      const start = { x: Math.max(4, center.x - 40), y: Math.max(4, center.y - 40) };
      const end = { x: Math.min(size.width - 4, center.x + 40), y: Math.min(size.height - 4, center.y + 40) };
      if (mobile) {
        await map.tap({ position: start });
        await expect(page.getByRole("button", { name: "Cancel selection" })).toBeVisible();
        await map.tap({ position: end });
      } else {
        await page.mouse.move(size.x + start.x, size.y + start.y);
        await page.mouse.down();
        await page.mouse.move(size.x + end.x, size.y + end.y, { steps: 8 });
        await expect(map.locator("path.leaflet-interactive")).toHaveCount(0); // rectangle is intentionally non-interactive
        await expect(map.locator(".leaflet-overlay-pane path")).toHaveCount(1);
        await page.mouse.up();
      }
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      await expect(map.locator(".leaflet-overlay-pane path")).toHaveCount(1);
      // Accessible manual coordinates replace and synchronize the rectangle.
      for (const [label, value] of [["South latitude", "44"], ["North latitude", "46"], ["West longitude", "13"], ["East longitude", "15"]]) {
        await page.getByLabel(label, { exact: true }).fill(value);
      }
      const apply = page.getByRole("button", { name: "Apply coordinates" });
      await apply.focus(); await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Select another area" })).toBeFocused();
      await expect(page).toHaveURL(/catalog_bbox_south=44/);
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      const selectedUrl = page.url();
      await map.scrollIntoViewIfNeeded();
      await expect(map.locator(".leaflet-overlay-pane path")).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`area-${mobile ? "mobile" : "desktop"}.png`), fullPage: true });
      await page.getByRole("link", { name: "View selected area in List" }).click();
      await expect(page.getByRole("article")).toHaveCount(2);
      await expect(page.getByRole("article").filter({ hasText: selectedName })).toHaveCount(1);
      await expect(page.getByLabel("Active geographic filter")).toContainText("44.00000");
      await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("pending");
      await expect(page.getByRole("article")).toHaveCount(2);
      await page.getByRole("link", { name: "View on Map", exact: true }).click();
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/catalog_status=pending/);
      await page.reload();
      await expect(page.getByLabel("South latitude", { exact: true })).toHaveValue("44");
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      await page.goto(`${page.url()}&photo=${ids[0]}`);
      await page.getByRole("button", { name: "Open map preview for " + selectedName }).click();
      await page.getByRole("link", { name: "Open photo", exact: true }).click();
      await expect(page).toHaveURL(/returnTo=.*catalog_bbox_south%3D44/);
      await page.getByRole("link", { name: "Back to catalog", exact: true }).click();
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Clear area", exact: true }).click();
      await expect(page.getByText("3 mapped photos", { exact: true })).toBeVisible();
      expect(page.url()).not.toContain("bbox");
      await page.goBack();
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      await page.goForward();
      await expect(page.getByText("3 mapped photos", { exact: true })).toBeVisible();
      await page.goto(selectedUrl);
      await expect(page.getByText("2 mapped photos match this area", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
  });
}
