import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

const transparentTile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`GPS picker ${viewport.name}: map, drag, draft, offline entry and bulk preview`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    let offline = false;
    await page.route("https://tile.openstreetmap.org/**", (route) => offline
      ? route.abort("internetdisconnected")
      : route.fulfill({ status: 200, contentType: "image/png", body: transparentTile }));
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const ids: number[] = [];
    const capture = { captured_at: "2024-02-29T23:30:12.123456", captured_at_offset_minutes: -330 };
    const getPhoto = async (id: number) => (await request.get(`${backend}/photos/${id}`)).json();
    const picker = page.getByRole("dialog", { name: "Choose GPS location" });
    const launchPicker = page.getByRole("button", { name: "Choose on map", exact: true });
    const edit = page.getByRole("button", { name: "Edit metadata", exact: true });
    try {
      for (let index = 0; index < 2; index++) {
        const response = await request.post(`${backend}/photos/upload`, { multipart: {
          allow_visual_duplicate: "true",
          file: { name: `gps-picker-${viewport.name}-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`gps-picker-${viewport.name}-${index}`)]) },
        } });
        expect(response.ok()).toBe(true);
        const uploaded = await response.json();
        ids.push(uploaded.id);
        const initialized = await request.patch(`${backend}/photos/${uploaded.id}?expected_updated_at=${encodeURIComponent(uploaded.updated_at)}`, { data: capture });
        expect(initialized.ok(), await initialized.text()).toBe(true);
      }
      await page.goto(`/photos/${ids[0]}`);
      await edit.click();
      await launchPicker.click();
      await expect(picker.getByLabel("Latitude", { exact: true })).toBeFocused();
      await expect(picker.getByRole("button", { name: "Use this location" })).toBeDisabled();
      const map = picker.getByRole("region", { name: "GPS location picker map" }).locator(".leaflet-container");
      await expect(map).toBeVisible();
      await expect(map.locator(".leaflet-marker-icon")).toHaveCount(0);
      // Selection depends on Leaflet geometry, never on external tile availability.
      await map.click({ position: { x: 140, y: 95 } });
      const marker = map.locator(".leaflet-marker-icon");
      await expect(marker).toBeVisible();
      const clickedLatitude = await picker.getByLabel("Latitude", { exact: true }).inputValue();
      const markerBox = await marker.boundingBox();
      if (!markerBox) throw new Error("Expected a visible selected marker");
      await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(markerBox.x + markerBox.width / 2 + 25, markerBox.y + markerBox.height / 2 + 18, { steps: 8 });
      await page.mouse.up();
      await expect(picker.getByLabel("Latitude", { exact: true })).not.toHaveValue(clickedLatitude);
      const selected = {
        latitude: Number(await picker.getByLabel("Latitude", { exact: true }).inputValue()),
        longitude: Number(await picker.getByLabel("Longitude", { exact: true }).inputValue()),
      };
      expect(Number.isFinite(selected.latitude)).toBe(true);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(await picker.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`gps-picker-${viewport.name}.png`) });
      await picker.getByRole("button", { name: "Use this location" }).click();
      expect(await getPhoto(ids[0])).toMatchObject({ ...capture, latitude: null, longitude: null });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(edit).toBeVisible();
      expect(await getPhoto(ids[0])).toMatchObject({ ...capture, ...selected, location_metadata_overridden: true, capture_metadata_overridden: true });

      // A new opening uses the persisted pair; Escape and editor Cancel leave it intact.
      await edit.click();
      await launchPicker.click();
      await expect(picker.getByLabel("Latitude", { exact: true })).toHaveValue(String(selected.latitude));
      await picker.getByLabel("Latitude", { exact: true }).fill("0");
      await picker.press("Escape");
      await expect(launchPicker).toBeFocused();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(await getPhoto(ids[0])).toMatchObject(selected);

      // Offline tiles show an actionable error while keyboard entry remains complete.
      offline = true;
      // A fresh document avoids reusing already decoded tile images from prior openings.
      await page.reload();
      await edit.click();
      await launchPicker.click();
      await expect(picker.getByRole("alert")).toContainText("Map unavailable");
      await picker.getByLabel("Latitude", { exact: true }).fill("0");
      await picker.getByLabel("Longitude", { exact: true }).fill("0");
      await picker.getByRole("button", { name: "Use this location" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(edit).toBeVisible();
      expect(await getPhoto(ids[0])).toMatchObject({ ...capture, latitude: 0, longitude: 0 });

      await page.goto(`/?catalog_search=gps-picker-${viewport.name}`);
      await page.getByRole("button", { name: "Select photos", exact: true }).click();
      for (const id of ids) await page.getByRole("checkbox", { name: new RegExp(`Select photo ${id}:`) }).check();
      await page.getByRole("button", { name: "Edit capture / GPS", exact: true }).click();
      const bulk = page.getByRole("dialog", { name: "Edit capture / GPS", exact: true });
      await bulk.getByLabel("Operation").selectOption("set_gps");
      await launchPicker.click();
      await picker.getByLabel("Latitude", { exact: true }).fill("-45.123456789");
      await picker.getByLabel("Longitude", { exact: true }).fill("180");
      await picker.getByRole("button", { name: "Use this location" }).click();
      await bulk.getByRole("button", { name: "Preview changes" }).click();
      await expect(bulk.getByRole("table")).toBeVisible();
      await expect(bulk.getByRole("button", { name: "Apply changes" })).toBeDisabled();
      await bulk.getByRole("checkbox", { name: /I reviewed/ }).check();
      await launchPicker.click();
      await picker.getByLabel("Longitude", { exact: true }).fill("-179.987654321");
      await picker.getByRole("button", { name: "Use this location" }).click();
      await expect(bulk.getByRole("table")).toHaveCount(0);
      expect(await getPhoto(ids[1])).toMatchObject({ latitude: null, longitude: null });
      await bulk.getByRole("button", { name: "Preview changes" }).click();
      await expect(bulk.getByRole("checkbox", { name: /I reviewed/ })).not.toBeChecked();
      await bulk.getByRole("checkbox", { name: /I reviewed/ }).check();
      await bulk.getByRole("button", { name: "Apply changes" }).click();
      await expect(bulk).toHaveCount(0);
      for (const id of ids) expect(await getPhoto(id)).toMatchObject({ ...capture, latitude: -45.123456789, longitude: -179.987654321 });
      await page.goto(`/photos/${ids[0]}`);
      await edit.click();
      await expect(page.getByLabel("Latitude", { exact: true })).toHaveValue("-45.123456789");
      await expect(page.getByLabel("Longitude", { exact: true })).toHaveValue("-179.987654321");
    } finally {
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
}
