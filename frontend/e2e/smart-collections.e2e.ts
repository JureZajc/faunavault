import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { backend as BACKEND_URL } from "./urls";

test("save and edit exact tags with metadata completeness in a Smart Collection", async ({ page, request }) => {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("Disposable E2E root is required");
  const tag = "E2E Smart Birds";
  const collectionName = "E2E Smart Bird Survey";
  const ids: number[] = [];
  try {
    const jpeg = await readFile(path.join(root, "fixtures", "faunavault-e2e-culling-pick.jpg"));
    for (const [index, name] of ["survey-missing.jpg", "survey-complete.jpg", "survey-lowercase.jpg"].entries()) {
      const uploaded = await request.post(`${BACKEND_URL}/photos/upload`, {
        multipart: {
          allow_visual_duplicate: "true",
          file: { name, mimeType: "image/jpeg", buffer: Buffer.concat([jpeg, Buffer.from(name)]) },
        },
      });
      expect(uploaded.ok()).toBe(true);
      const { id, updated_at } = await uploaded.json();
      ids.push(id);
      const metadata = await request.patch(`${BACKEND_URL}/photos/${id}`, {
        params: { expected_updated_at: updated_at },
        data: {
          tags: [index === 2 ? tag.toLowerCase() : tag],
          captured_at: "2026-04-01T08:00:00", captured_at_offset_minutes: null,
          latitude: index === 1 ? 0 : null, longitude: index === 1 ? 0 : null,
        },
      });
      expect(metadata.ok()).toBe(true);
    }

    await page.setViewportSize({ width: 360, height: 760 });
    await page.goto("/");
    await page.getByLabel("Search tag options").fill(tag);
    await page.getByLabel("Add exact tag").selectOption(tag);
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.getByLabel("Metadata completeness").selectOption("missing_gps");
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article").getByText("survey-missing.jpg", { exact: true })).toBeVisible();

    const save = page.getByRole("button", { name: "Save as Smart Collection" });
    await save.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Create Smart Collection" });
    const name = dialog.getByRole("textbox", { name: "Smart Collection name" });
    await expect(name).toBeFocused();
    await name.fill(collectionName);
    await name.press("Enter");
    await expect(page.getByRole("heading", { name: collectionName })).toBeVisible();
    await expect(page.getByText(/Tags \(all\): "E2E Smart Birds".*Metadata: Missing GPS/)).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article").getByText("survey-missing.jpg", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const detail = page.url();

    await page.getByRole("link", { name: "Edit criteria" }).click();
    await expect(page.getByRole("button", { name: `Remove tag ${tag}` })).toBeVisible();
    await expect(page.getByLabel("Metadata completeness")).toHaveValue("missing_gps");
    await page.getByLabel("Metadata completeness").selectOption("complete");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(detail);
    await expect(page.getByText(/Metadata: Complete/)).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article").getByText("survey-complete.jpg", { exact: true })).toBeVisible();
    await expect(page.getByText("survey-missing.jpg", { exact: true })).toHaveCount(0);

    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(page.getByLabel("Metadata completeness")).toHaveValue("");
    await page.getByRole("searchbox", { name: "Search", exact: true }).fill("survey-lowercase");
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(page.getByRole("article").getByText("survey-lowercase.jpg", { exact: true })).toBeVisible();
  } finally {
    const response = await request.get(`${BACKEND_URL}/smart-collections`);
    if (response.ok()) {
      for (const collection of await response.json()) {
        if (collection.name === collectionName) await request.delete(`${BACKEND_URL}/smart-collections/${collection.id}`);
      }
    }
    for (const id of ids) {
      await request.delete(`${BACKEND_URL}/photos/${id}`);
      await request.delete(`${BACKEND_URL}/trash/photos/${id}`);
    }
  }
});
