import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

const TRANSPARENT_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=", "base64");

for (const mobile of [false, true]) {
  test.describe(mobile ? "Nearby mobile" : "Nearby desktop", () => {
    test.use(mobile ? { viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true } : {});
    test("nearby radius, source return, Trash/Restore, GPS corrections and keyboard navigation", async ({ page, request }, testInfo) => {
      const root = process.env.FAUNAVAULT_E2E_ROOT;
      if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
      await page.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
      const bytes = await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg"));
      const ids: number[] = [];
      const prefix = `nearby-${mobile ? "mobile" : "desktop"}`;
      const title = (index: number) => `${prefix}-${index}`;
      try {
        for (const [index, delta] of [0, 0.002, 0.006, 0.06, 0.3].entries()) {
          const upload = await request.post(`${backend}/photos/upload`, { multipart: {
            allow_visual_duplicate: "true",
            file: { name: `${title(index)}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([bytes, Buffer.from(title(index))]) },
          } });
          expect(upload.ok(), await upload.text()).toBe(true);
          const photo = await upload.json(); ids.push(photo.id);
          const edit = await request.patch(`${backend}/photos/${photo.id}`, { params: { expected_updated_at: photo.updated_at }, data: {
            display_title: title(index), latitude: -62.4 + delta, longitude: -142.1,
            captured_at: "2001-04-05T12:30:00", captured_at_offset_minutes: null,
          } });
          expect(edit.ok(), await edit.text()).toBe(true);
        }
        const sourceUrl = `/photos/${ids[0]}?returnTo=%2Fmap&nearby_radius=1`;
        await page.goto(sourceUrl);
        const section = page.getByRole("region", { name: "Nearby Photos", exact: true });
        const cards = section.getByRole("list", { name: "Nearby photos" }).getByRole("listitem");
        const radius = section.getByRole("combobox", { name: "Search radius" });
        await expect(cards).toHaveCount(2);
        await expect(section.getByRole("link", { name: new RegExp(title(1)) })).toBeVisible();
        await expect(section.getByRole("link", { name: new RegExp(title(2)) })).toBeVisible();
        await expect(section.getByText(/m away/).first()).toBeVisible();
        await expect(page.getByRole("link", { name: "View on map", exact: true })).toHaveAttribute("href", `/map?photo=${ids[0]}`);

        await radius.focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        // Windows Chromium can open the native select popup on Enter after
        // ArrowDown has already selected the value. Close it before tabbing.
        await page.keyboard.press("Escape");
        await expect(radius).toHaveValue("10");
        await expect(radius).toBeFocused();
        await expect(cards).toHaveCount(3);
        await expect(section.getByRole("link", { name: new RegExp(title(3)) })).toBeVisible();
        await expect(section.getByRole("link", { name: new RegExp(title(4)) })).toHaveCount(0);
        expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/map");
        const imageBefore = await page.getByRole("button", { name: "Open fullscreen image" }).getByRole("img").getAttribute("src");
        await page.keyboard.press("Tab");
        const firstLink = section.getByRole("link").first();
        await expect(firstLink).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath("nearby-photos.png"), fullPage: true });
        await page.keyboard.press("Enter");
        await expect(page.getByRole("heading", { level: 1, name: title(1), exact: true })).toBeVisible();
        const back = page.getByRole("link", { name: "Back to source photo" });
        await expect(back).toHaveAttribute("href", `/photos/${ids[0]}?nearby_radius=10`);
        const nested = new URL(page.url()).searchParams.get("returnTo")!;
        expect(new URL(nested, page.url()).searchParams.has("returnTo")).toBe(false);
        await back.click();
        await expect(radius).toHaveValue("10");
        await expect(cards).toHaveCount(3);
        expect(await page.getByRole("button", { name: "Open fullscreen image" }).getByRole("img").getAttribute("src")).toBe(imageBefore);

        // Trash from the nearby Photo's own UI returns to the source and refreshes.
        await section.getByRole("link", { name: new RegExp(title(1)) }).click();
        await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Move photo to Trash" });
        await dialog.getByLabel("Type the filename to confirm").fill(`${title(1)}.jpg`);
        await dialog.getByRole("button", { name: "Move to Trash", exact: true }).click();
        await expect(page.getByRole("heading", { level: 1, name: title(0), exact: true })).toBeVisible();
        await expect(cards).toHaveCount(2);
        await expect(section.getByRole("link", { name: new RegExp(title(1)) })).toHaveCount(0);
        const restored = await request.post(`${backend}/trash/photos/${ids[1]}/restore`);
        expect(restored.ok(), await restored.text()).toBe(true);
        await page.reload();
        await expect(cards).toHaveCount(3);

        const other = await (await request.get(`${backend}/photos/${ids[2]}`)).json();
        const cleared = await request.patch(`${backend}/photos/${ids[2]}`, { params: { expected_updated_at: other.updated_at }, data: { latitude: null, longitude: null } });
        expect(cleared.ok(), await cleared.text()).toBe(true);
        await radius.selectOption("25");
        await expect(cards).toHaveCount(2);
        await expect(section.getByRole("link", { name: new RegExp(title(4)) })).toHaveCount(0);
        await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
        await page.getByLabel("Latitude", { exact: true }).fill("");
        await page.getByLabel("Longitude", { exact: true }).fill("");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.getByRole("button", { name: "Edit metadata", exact: true })).toBeVisible();
        await expect(section).toHaveCount(0);
      } finally {
        for (const id of ids) {
          await request.delete(`${backend}/photos/${id}`);
          await request.delete(`${backend}/trash/photos/${id}`);
        }
      }
    });
  });
}
