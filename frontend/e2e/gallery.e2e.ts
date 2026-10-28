import { APIRequestContext, expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

async function uploadMembers(request: APIRequestContext, ids: number[], count: number) {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Use npm run test:e2e for disposable storage.");
  const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
  const token = randomUUID();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `gallery-${token}-${i}.jpg`;
    const response = await request.post(`${backend}/photos/upload`, { multipart: {
      allow_visual_duplicate: "true",
      file: { name, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(`${token}-${i}`)]) },
    } });
    expect(response.ok()).toBe(true);
    ids.push((await response.json()).id);
    names.push(name);
  }
  return names;
}

async function removePhotos(request: APIRequestContext, ids: number[]) {
  for (const id of ids) {
    await request.delete(`${backend}/photos/${id}`);
    await request.delete(`${backend}/trash/photos/${id}`);
  }
}

test("Collection gallery crosses pages, plays and returns to the original grid", async ({ page, request }) => {
  test.setTimeout(150_000);
  const ids: number[] = [];
  let collectionId: number | undefined;
  const originalRequests: string[] = [];
  page.on("request", (req) => { if (req.url().includes("/images/original/")) originalRequests.push(req.url()); });
  try {
    const names = await uploadMembers(request, ids, 49);
    const created = await request.post(`${backend}/collections`, { data: { name: "Disposable slideshow collection" } });
    expect(created.ok()).toBe(true);
    collectionId = (await created.json()).id;
    expect((await request.post(`${backend}/collections/${collectionId}/photos`, { data: { photo_ids: ids } })).ok()).toBe(true);
    await page.goto(`/collections/${collectionId}?page=2`);
    await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
    const opener = page.getByRole("button", { name: `Open gallery: ${names[0]}`, exact: true });
    await opener.click();
    const viewer = page.getByRole("dialog", { name: "Fullscreen image viewer" });
    await expect(viewer.getByText("49 of 49", { exact: true })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Next image", exact: true })).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.getByText("48 of 49", { exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Next image", exact: true }).click();
    await expect(viewer.getByText("49 of 49", { exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Previous image", exact: true }).click();
    await expect(viewer.getByText("48 of 49", { exact: true })).toBeVisible();
    await viewer.getByLabel("Slideshow interval").selectOption("3");
    await expect(viewer.getByRole("img")).toBeVisible();
    await viewer.getByRole("button", { name: "Play slideshow" }).click();
    await expect(viewer.getByText("Playing", { exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Pause slideshow" }).click();
    await expect(viewer.getByText("Paused", { exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Play slideshow" }).click();
    await expect(viewer.getByText("49 of 49", { exact: true })).toBeVisible();
    await expect(viewer.getByText("Paused", { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("gallery-desktop.png") });
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/collections/${collectionId}\\?page=2$`));
    await expect(page.getByText("Page 2 of 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("article").getByText(names[0], { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open gallery", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("1 of 49", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(originalRequests).toEqual([]);
  } finally {
    if (collectionId) await request.delete(`${backend}/collections/${collectionId}`);
    await removePhotos(request, ids);
  }
});

test("Event gallery starts at a distant custom cover, crosses pages and falls back from Trash", async ({ page, request }) => {
  test.setTimeout(150_000);
  const ids: number[] = [];
  let eventId: number | undefined;
  try {
    await uploadMembers(request, ids, 49);
    const created = await request.post(`${backend}/events`, { data: {
      kind: "trip", title: "Disposable gallery trip", start_date: "2026-08-12", end_date: "2026-08-17",
    } });
    expect(created.ok()).toBe(true);
    eventId = (await created.json()).id;
    expect((await request.post(`${backend}/events/${eventId}/photos`, { data: { photo_ids: ids } })).ok()).toBe(true);
    expect((await request.patch(`${backend}/events/${eventId}/cover`, { data: { photo_id: ids[0] } })).ok()).toBe(true);
    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto(`/events/${eventId}`);
    await page.getByRole("button", { name: "View gallery", exact: true }).click();
    const viewer = page.getByRole("dialog");
    await expect(viewer.getByText("49 of 49", { exact: true })).toBeVisible();
    await viewer.getByRole("button", { name: "Previous image", exact: true }).click();
    await expect(viewer.getByText("48 of 49", { exact: true })).toBeVisible();
    await expect(viewer.getByRole("img")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("gallery-mobile.png") });
    await page.keyboard.press("Escape");
    expect((await (await request.get(`${backend}/events/${eventId}`)).json()).cover_photo_id).toBe(ids[0]);
    expect((await request.delete(`${backend}/photos/${ids[0]}`)).ok()).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "View gallery", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("1 of 48", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await (await request.get(`${backend}/events/${eventId}`)).json()).cover_photo_id).toBe(ids[0]);
  } finally {
    if (eventId) await request.delete(`${backend}/events/${eventId}`);
    await removePhotos(request, ids);
  }
});
