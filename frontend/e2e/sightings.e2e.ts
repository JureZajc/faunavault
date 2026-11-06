import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

test("record, edit and delete a wildlife encounter while keeping its originals", async ({ page, request }) => {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Run with npm run test:e2e for disposable archive storage.");
  const token = `sighting-${randomUUID()}`;
  const photos: { id: number; name: string; stored: string; original: Buffer }[] = [];
  let sightingId: number | undefined;
  try {
    for (const [index, fixture] of ["timeline-january", "timeline-february", "capture-edit"].entries()) {
      const name = `${token}-${index}.jpg`;
      const source = await readFile(path.join(root, "fixtures", `faunavault-e2e-${fixture}.jpg`));
      const original = Buffer.concat([source, Buffer.from(name)]);
      const upload = await request.post(`${backend}/photos/upload`, { multipart: {
        allow_visual_duplicate: "true", file: { name, mimeType: "image/jpeg", buffer: original },
      } });
      expect(upload.ok()).toBe(true);
      const photo = await upload.json();
      photos.push({ id: photo.id, stored: photo.stored_filename, name, original });
    }
    await page.goto("/");
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill(token);
    await expect(page.getByRole("article").filter({ hasText: token })).toHaveCount(3);
    await page.getByRole("button", { name: "Select photos", exact: true }).click();
    for (const photo of photos.slice(0, 2)) await page.getByRole("checkbox", { name: new RegExp(`Select photo ${photo.id}:`) }).check();

    await page.getByRole("button", { name: "Create Sighting", exact: true }).focus();
    await page.keyboard.press("Enter");
    const form = page.getByRole("dialog", { name: "Create Sighting" });
    await expect(form.getByText("2 selected photos")).toBeVisible();
    await expect(form.getByText(/different capture times/)).toBeVisible();
    await expect(form.getByLabel(/Observation date and time/)).toHaveValue("");
    await form.getByLabel(/Subject label/).fill("Fox at the meadow");
    await form.getByLabel(/Observation date and time/).fill("2026-08-23T19:30");
    await form.getByLabel(/UTC offset/).fill("+02:00");
    await form.getByLabel(/Location label/).fill("North meadow");
    await form.getByLabel(/Field notes/).fill("One fox crossing the path.");
    await form.getByRole("button", { name: "Save Sighting" }).click();
    await expect(page).toHaveURL(/\/sightings\/[1-9]\d*$/);
    sightingId = Number(new URL(page.url()).pathname.split("/").pop());
    const detailUrl = `/sightings/${sightingId}`;

    await page.getByRole("link", { name: "Back to Sightings Journal" }).click();
    const card = page.getByRole("link", { name: /Fox at the meadow/ });
    await expect(card).toContainText("North meadow");
    await expect(card).toContainText("2 active photos");
    await expect(card.getByRole("img")).toBeVisible();
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await card.click();
    await expect(page.getByRole("heading", { name: "Fox at the meadow" })).toBeVisible();
    await expect(page.getByText(/UTC\+02:00/)).toBeVisible();
    await expect(page.getByText("Unidentified", { exact: true })).toBeVisible();
    await expect(page.getByText("One fox crossing the path.")).toBeVisible();
    const gallery = page.getByRole("region", { name: "Linked photos" });
    await expect(gallery.getByText("2 active · 0 in Trash")).toBeVisible();
    await expect(gallery.getByRole("article")).toHaveCount(2);
    await expect(gallery.getByText(photos[2].name)).toHaveCount(0);
    await gallery.getByRole("button", { name: "Open gallery" }).click();
    await expect(page.getByRole("dialog").getByRole("img")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(gallery.getByRole("button", { name: "Open gallery" })).toBeFocused();

    await page.getByRole("button", { name: "Edit Sighting" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Sighting" });
    await edit.getByLabel(/Field notes/).fill("The fox paused by the oak.");
    await edit.getByRole("button", { name: "Save Sighting" }).click();
    await expect(page.getByText("The fox paused by the oak.")).toBeVisible();
    await gallery.getByRole("button", { name: `Remove ${photos[0].name} from sighting` }).click();
    await page.getByRole("dialog", { name: "Remove photo from sighting?" }).getByRole("button", { name: "Remove photo" }).click();
    await expect(gallery.getByText("1 active · 0 in Trash")).toBeVisible();
    await expect(gallery.getByRole("article")).toHaveCount(1);

    await page.getByRole("link", { name: "Add existing photos" }).click();
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill(token);
    await expect(page.getByRole("article").filter({ hasText: token })).toHaveCount(3);
    await page.getByRole("button", { name: "Select photos to link" }).click();
    await page.getByRole("checkbox", { name: new RegExp(`Select photo ${photos[2].id}:`) }).check();
    await page.getByRole("button", { name: "Add 1 selected to sighting" }).click();
    await expect(gallery.getByText("2 active · 0 in Trash")).toBeVisible();

    await gallery.getByRole("link", { name: new RegExp(photos[1].name) }).click();
    await expect(page).toHaveURL(new RegExp(`/photos/${photos[1].id}\\?`));
    const links = page.getByRole("region", { name: "Sightings", exact: true });
    await expect(links.getByRole("link", { name: /Fox at the meadow/ })).toHaveAttribute("href", detailUrl);
    await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
    const trash = page.getByRole("dialog", { name: "Move photo to Trash" });
    await trash.getByLabel("Type the filename to confirm").fill(photos[1].name);
    await trash.getByRole("button", { name: "Move to Trash", exact: true }).click();
    await expect(gallery.getByText("1 active · 1 in Trash")).toBeVisible();
    await expect(gallery.getByText(photos[1].name)).toHaveCount(0);
    await page.getByRole("navigation", { name: "Archive views" }).getByRole("link", { name: "Trash" }).click();
    await page.getByRole("article").filter({ hasText: photos[1].name }).getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: photos[1].name })).toHaveCount(0);
    await page.goto(detailUrl);
    await expect(gallery.getByText("2 active · 0 in Trash")).toBeVisible();
    await expect(gallery.getByText(photos[1].name)).toBeVisible();

    await page.getByRole("button", { name: "Delete Sighting" }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete Sighting?" });
    await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
    await confirmation.getByRole("button", { name: "Delete Sighting" }).click();
    await expect(page).toHaveURL(/\/sightings$/);
    await expect(page.getByRole("heading", { name: "No sightings recorded yet" })).toBeVisible();
    for (const photo of photos) {
      const retained = await request.get(`${backend}/photos/${photo.id}`);
      expect(await retained.json()).toMatchObject({ deleted_at: null, original_filename: photo.name });
      expect(await readFile(path.join(root, "images", "original", photo.stored))).toEqual(photo.original);
    }
  } finally {
    if (sightingId) await request.delete(`${backend}/sightings/${sightingId}`);
    for (const photo of photos) {
      await request.delete(`${backend}/photos/${photo.id}`);
      await request.delete(`${backend}/trash/photos/${photo.id}`);
    }
  }
});
