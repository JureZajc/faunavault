import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend } from "./urls";

test("browse verified encounters by year and refresh the Life List after a sighting edit", async ({ page, request }) => {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Run with npm run test:e2e for disposable archive storage.");
  const taxa: Record<"fox" | "owl" | "raven", number> = JSON.parse(execFileSync("uv", [
    "run", "--no-sync", "python", path.join(__dirname, "seed-life-list-taxa.py"),
  ], { cwd: path.resolve(__dirname, "../../backend"), encoding: "utf8", windowsHide: true }));
  const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-timeline-january.jpg"));
  const name = `life-list-${randomUUID()}.jpg`;
  const upload = await request.post(`${backend}/photos/upload`, { multipart: {
    allow_visual_duplicate: "true",
    file: { name, mimeType: "image/jpeg", buffer: Buffer.concat([source, Buffer.from(name)]) },
  } });
  expect(upload.ok()).toBe(true);
  const photoId: number = (await upload.json()).id;
  const encounterIds: number[] = [];

  try {
    for (const [key, observed_at] of [
      ["fox", "2024-01-01T00:10:00"],
      ["fox", "2025-03-11T12:00:00"],
      ["fox", "2025-05-03T18:00:00"],
      ["raven", "2024-04-09T10:00:00"],
      ["owl", "2025-06-15T20:45:00"],
    ] as const) {
      const response = await request.post(`${backend}/sightings`, { data: {
        photo_ids: [photoId], taxon_id: taxa[key], observed_at,
      } });
      expect(response.status()).toBe(201);
      encounterIds.push((await response.json()).id);
    }

    await page.goto("/sightings");
    await page.getByRole("link", { name: "Explore your Life List" }).click();
    await expect(page.getByRole("heading", { name: "Wildlife Life List" })).toBeVisible();
    const metric = (label: string) => page.getByText(label, { exact: true }).locator("..").locator("dd");
    const list = page.getByRole("list", { name: "Verified taxa" });
    const year = page.getByRole("combobox", { name: "Observation year" });
    const sort = page.getByRole("combobox", { name: "Sort taxa" });
    const search = page.getByRole("searchbox", { name: "Search names" });
    const seen = page.getByRole("radio", { name: "Seen", exact: true });
    const newTaxa = page.getByRole("radio", { name: "First recorded this year" });
    await expect(metric("All-time verified taxa")).toHaveText("3");
    await expect(metric("Sightings in this view")).toHaveText("5");
    await expect(list.getByRole("article")).toHaveCount(3);
    await expect(list.getByRole("article").filter({ hasText: "Fixture Red fox" })).toContainText("3 sightings");
    await expect(list.getByRole("img").first()).toBeVisible();
    await page.setViewportSize({ width: 375, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await year.selectOption("2025");
    await expect(metric("Verified taxa seen in 2025")).toHaveText("2");
    await expect(metric("Verified taxa first recorded in 2025")).toHaveText("1");
    await expect(metric("Sightings in this view")).toHaveText("3");
    await expect(list.getByRole("article")).toHaveCount(2);
    await sort.selectOption("most_observed");
    await expect(list.getByRole("heading").first()).toHaveText("Fixture Red fox");
    await search.fill("Fixture");
    await search.press("Enter");
    await expect(page).toHaveURL(/search=Fixture/);
    await newTaxa.click();
    await expect(newTaxa).toBeChecked();
    await expect(list.getByRole("article")).toHaveCount(1);
    await expect(metric("Sightings in this view")).toHaveText("1");
    const filteredUrl = page.url();

    await list.getByRole("link", { name: /First sighting of Tyto alba/ }).click();
    await expect(page).toHaveURL(new RegExp(`/sightings/${encounterIds.at(-1)}$`));
    await page.getByRole("button", { name: "Edit Sighting" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Sighting" });
    await edit.getByLabel(/Observation date and time/).fill("2024-06-15T20:45");
    await edit.getByRole("button", { name: "Save Sighting" }).click();
    await expect(page.getByText(/Jun 15, 2024/)).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(filteredUrl);
    await expect(year).toHaveValue("2025");
    await expect(sort).toHaveValue("most_observed");
    await expect(search).toHaveValue("Fixture");
    await expect(newTaxa).toBeChecked();
    await expect(metric("All-time verified taxa")).toHaveText("3");
    await expect(metric("Verified taxa seen in 2025")).toHaveText("1");
    await expect(metric("Verified taxa first recorded in 2025")).toHaveText("0");
    await expect(metric("Sightings in this view")).toHaveText("0");
    await expect(page.getByRole("heading", { name: "No matching verified taxa" })).toBeVisible();

    await page.goBack();
    await expect(seen).toBeChecked();
    await expect(list.getByRole("heading")).toHaveText("Fixture Red fox");
    await page.goForward();
    await expect(page).toHaveURL(filteredUrl);
    await expect(newTaxa).toBeChecked();
    await expect(metric("Sightings in this view")).toHaveText("0");
  } finally {
    for (const id of encounterIds) await request.delete(`${backend}/sightings/${id}`);
    await request.delete(`${backend}/photos/${photoId}`);
    await request.delete(`${backend}/trash/photos/${photoId}`);
  }
});
