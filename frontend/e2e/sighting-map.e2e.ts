import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

const tile = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=", "base64");

test("map counts encounters, filters in history, and reflects edits, Trash and Sighting deletion", async ({ page, request }) => {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Run with npm run test:e2e for disposable archive storage.");
  const taxa: { fox: number; owl: number } = JSON.parse(execFileSync("uv", [
    "run", "--no-sync", "python", path.join(__dirname, "seed-life-list-taxa.py"),
  ], { cwd: path.resolve(__dirname, "../../backend"), encoding: "utf8", windowsHide: true }));
  await page.route(/^https:\/\/tile\.openstreetmap\.org\//, (route) => route.fulfill({ contentType: "image/png", body: tile }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const photoIds: number[] = [];
  const sightingIds: number[] = [];
  const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-timeline-january.jpg"));

  try {
    for (let index = 0; index < 3; index++) {
      const name = `sighting-map-${randomUUID()}.jpg`;
      const response = await request.post(`${backend}/photos/upload`, { multipart: {
        allow_visual_duplicate: "true",
        file: { name, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(name)]) },
      } });
      expect(response.ok(), await response.text()).toBe(true);
      photoIds.push((await response.json()).id);
    }
    for (const observation of [
      { subject_label: "Fox crossing", taxon_id: taxa.fox, observed_at: "2005-05-01T23:55:00", latitude: 0, longitude: 0, photo_ids: photoIds.slice(0, 2) },
      { subject_label: "Owl hunting", taxon_id: taxa.owl, observed_at: "2005-05-02T00:05:00", latitude: 40, longitude: 60, photo_ids: [photoIds[2]] },
      { subject_label: "Fox without coordinates", taxon_id: taxa.fox, observed_at: "2005-05-01T10:00:00", photo_ids: [photoIds[0]] },
    ]) {
      const response = await request.post(`${backend}/sightings`, { data: observation });
      expect(response.status(), await response.text()).toBe(201);
      sightingIds.push((await response.json()).id);
    }
    const [foxId, owlId, unlocatedId] = sightingIds;
    await page.goto("/sightings");
    await page.getByRole("link", { name: "View Sightings Map" }).click();
    await expect(page.getByRole("heading", { name: "Wildlife Sightings Map" })).toBeVisible();
    const map = page.getByRole("region", { name: "Interactive Sightings Map" });
    const markers = map.getByRole("button", { name: /^Open map preview for/ });
    const fox = map.getByRole("button", { name: "Open map preview for Fox crossing" });
    const popup = map.locator(".leaflet-popup");
    await expect(markers).toHaveCount(2);
    await expect(page.getByText("3 matching sightings", { exact: true })).toBeVisible();
    await expect(page.getByText("2 mapped encounters", { exact: true })).toBeVisible();
    await expect(page.getByText("1 without GPS", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByLabel("From date", { exact: true }).fill("2005-05-01");
    await page.getByLabel("Through date", { exact: true }).fill("2005-05-01");
    await page.getByRole("button", { name: "Apply dates" }).click();
    await expect(page).toHaveURL(/date_from=2005-05-01&date_to=2005-05-01/);
    await expect(markers).toHaveCount(1);
    await page.getByRole("button", { name: "Choose species" }).click();
    await page.getByLabel("Search local species").fill("Fixture Barn owl");
    await page.getByRole("button", { name: /Fixture Barn owl/ }).click();
    await expect(page.getByRole("heading", { name: "No matching sightings with GPS" })).toBeVisible();
    await expect(markers).toHaveCount(0);
    await page.getByRole("button", { name: "Choose species" }).click();
    await page.getByLabel("Search local species").fill("Fixture Red fox");
    await page.getByRole("button", { name: /Fixture Red fox/ }).click();
    await expect(page).toHaveURL(new RegExp(`taxon_id=${taxa.fox}$`));
    await expect(page.getByText("2 matching sightings", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(markers).toHaveCount(2);
    await page.goBack();
    await expect(page.getByLabel("From date", { exact: true })).toHaveValue("2005-05-01");
    await expect(markers).toHaveCount(1);
    await page.goForward();
    await expect(markers).toHaveCount(2);

    // Distinct encounters can overlap exactly. Verify the real cluster can
    // reveal both and a focused URL can still open the intended one.
    const overlap = await request.patch(`${backend}/sightings/${owlId}`, { data: { latitude: 0, longitude: 0 } });
    expect(overlap.ok(), await overlap.text()).toBe(true);
    await page.reload();
    const cluster = map.locator(".marker-cluster");
    await expect(cluster).toHaveText("2");
    await cluster.click();
    await expect(markers).toHaveCount(2);
    await page.goto(`/sightings/map?focus=${foxId}`);
    await expect(popup.getByText("Fox crossing", { exact: true })).toBeVisible();
    const separate = await request.patch(`${backend}/sightings/${owlId}`, { data: { latitude: 40, longitude: 60 } });
    expect(separate.ok(), await separate.text()).toBe(true);
    await page.goto("/sightings/map");

    await fox.focus();
    await page.keyboard.press("Enter");
    await expect(popup.getByRole("img")).toBeVisible();
    await popup.getByRole("link", { name: "Open Sighting" }).click();
    await expect(page).toHaveURL(new RegExp(`/sightings/${foxId}$`));
    const focusLink = page.getByRole("link", { name: "View on Sightings Map" });
    await expect(focusLink).toHaveAttribute("href", `/sightings/map?focus=${foxId}`);
    await focusLink.click();
    await expect(popup.getByText("Fox crossing", { exact: true })).toBeVisible();
    await popup.getByRole("link", { name: "Open Sighting" }).click();

    await page.getByRole("button", { name: "Edit Sighting" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Sighting" });
    await edit.getByLabel(/^Latitude/).fill("-25");
    await edit.getByLabel(/^Longitude/).fill("-80");
    await edit.getByRole("button", { name: "Save Sighting" }).click();
    await expect(page.getByText("-25, -80", { exact: true })).toBeVisible();
    await focusLink.click();
    await expect(popup.getByText("Fox crossing", { exact: true })).toBeVisible();
    await page.reload();
    await expect(popup.getByText("Fox crossing", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Search this map area" }).click();
    await expect(page).toHaveURL(/bbox_south=-25.*bbox_west=-80/);
    await expect(page.getByText("1 mapped encounter in this area", { exact: true })).toBeVisible();
    await expect(fox).toBeVisible();
    expect(new URL(page.url()).searchParams.has("focus")).toBe(false);

    for (const id of photoIds.slice(0, 2)) {
      const response = await request.delete(`${backend}/photos/${id}`);
      expect(response.ok(), await response.text()).toBe(true);
    }
    await page.reload();
    await fox.click();
    await expect(popup.getByRole("link", { name: "Open Sighting" })).toBeVisible();
    await expect(popup.getByRole("img")).toHaveCount(0);
    await popup.getByRole("link", { name: "Open Sighting" }).click();
    await page.getByRole("button", { name: "Delete Sighting" }).click();
    await page.getByRole("dialog", { name: "Delete Sighting?" }).getByRole("button", { name: "Delete Sighting" }).click();
    await page.getByRole("link", { name: "View Sightings Map" }).click();
    await expect(markers).toHaveCount(1);
    await expect(fox).toHaveCount(0);
    await expect(page.getByText("1 without GPS", { exact: true })).toBeVisible();

    await page.goto(`/sightings/${unlocatedId}`);
    await expect(page.getByText(/Add Sighting coordinates/)).toBeVisible();
    await expect(focusLink).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    for (const id of sightingIds) await request.delete(`${backend}/sightings/${id}`);
    for (const id of photoIds) {
      await request.delete(`${backend}/photos/${id}`);
      await request.delete(`${backend}/trash/photos/${id}`);
    }
  }
});
