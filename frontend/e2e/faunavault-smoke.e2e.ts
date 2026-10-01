import { expect, type Locator, type Page, test } from "@playwright/test";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const ORIGINAL_FILENAME = "faunavault-e2e-original.jpg";
const RECOMPRESSED_FILENAME = "faunavault-e2e-recompressed.jpg";
const UPDATED_TITLE = "FaunaVault E2E specimen";
const BULK_FIRST_FILENAME = "faunavault-e2e-bulk-first.jpg";
const BULK_SECOND_FILENAME = "faunavault-e2e-bulk-second.jpg";
const HEIC_FILENAME = "faunavault-e2e-iphone.heic";
const TIMELINE_JANUARY_FILENAME = "faunavault-e2e-timeline-january.jpg";
const TIMELINE_FEBRUARY_FILENAME = "faunavault-e2e-timeline-february.jpg";
const CAPTURE_EDIT_FILENAME = "faunavault-e2e-capture-edit.jpg";
const COLLECTION_NAME = "FaunaVault E2E bulk collection";
const SMART_COLLECTION_NAME = "FaunaVault E2E birds";
const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function testRoot() {
  const root = process.env.FAUNAVAULT_E2E_ROOT;
  if (!root) throw new Error("FAUNAVAULT_E2E_ROOT is required");
  return root;
}

function fixturePath(filename: string) {
  return path.join(testRoot(), "fixtures", filename);
}



function uploadProgress(page: Page) {
  return page.getByRole("region", { name: "Upload progress" });
}

function uploadRow(page: Page, filename: string) {
  return uploadProgress(page)
    .getByRole("listitem")
    .filter({ hasText: filename });
}

function catalogCard(page: Page, text: string) {
  return page.getByRole("article").filter({ hasText: text });
}

async function uploadFile(page: Page, filename: string) {
  await page
    .getByLabel("Add to collection", { exact: false })
    .setInputFiles(fixturePath(filename));
  await page.getByRole("button", { name: "Upload photo" }).click();
}

async function expectDecodedImage(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(
        (element) =>
          element instanceof HTMLImageElement &&
          element.complete &&
          element.naturalWidth > 0,
      ),
    )
    .toBe(true);
}

test("critical upload, detail, and Trash lifecycle", async ({ page }) => {
  let detailLocation = "";

  await test.step("upload and duplicate safety", async () => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Start your animal archive" }),
    ).toBeVisible();
    await expect(page.getByText("0 photos", { exact: true })).toBeVisible();

    await uploadFile(page, ORIGINAL_FILENAME);
    const uploadedRow = uploadRow(page, ORIGINAL_FILENAME);
    await expect(uploadedRow).toContainText("Uploaded");
    await expect(page.getByText("1 photo", { exact: true })).toBeVisible();
    const initialCard = catalogCard(page, ORIGINAL_FILENAME);
    await expect(initialCard).toHaveCount(1);
    await expectDecodedImage(
      initialCard.getByRole("img", { name: "Unclassified" }),
    );

    await page.reload();
    const persistedCard = catalogCard(page, ORIGINAL_FILENAME);
    await expect(persistedCard).toHaveCount(1);
    await expectDecodedImage(
      persistedCard.getByRole("img", { name: "Unclassified" }),
    );

    await uploadFile(page, ORIGINAL_FILENAME);
    const exactRow = uploadRow(page, ORIGINAL_FILENAME);
    await expect(exactRow).toContainText("Exact duplicate");
    const existingPhotoLink = exactRow.getByRole("link", {
      name: "View existing photo",
    });
    await expect(existingPhotoLink).toBeVisible();
    await expect(existingPhotoLink).toHaveAttribute("href", /\/photos\/\d+/);
    await expect(page.getByRole("dialog", { name: "Possible duplicate" })).toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Keep both" })).toHaveCount(0);
    await expect(catalogCard(page, ORIGINAL_FILENAME)).toHaveCount(1);
    await expect(page.getByText("1 photo", { exact: true })).toBeVisible();

    await uploadFile(page, RECOMPRESSED_FILENAME);
    const duplicateDialog = page.getByRole("dialog", {
      name: "Possible duplicate",
    });
    await expect(duplicateDialog).toBeVisible();
    await expect(
      duplicateDialog.getByRole("heading", { name: ORIGINAL_FILENAME }),
    ).toBeVisible();
    await expect(duplicateDialog.getByText("Catalog", { exact: true })).toBeVisible();
    await expectDecodedImage(
      duplicateDialog.getByRole("img", {
        name: `Existing photo: ${ORIGINAL_FILENAME}`,
      }),
    );
    await duplicateDialog.getByRole("button", { name: "Cancel upload" }).click();
    await expect(duplicateDialog).toHaveCount(0);
    await expect(uploadRow(page, RECOMPRESSED_FILENAME)).toContainText("Cancelled");
    await expect(catalogCard(page, ORIGINAL_FILENAME)).toHaveCount(1);
  });

  await test.step("catalog, detail image, and metadata PATCH", async () => {
    const card = catalogCard(page, ORIGINAL_FILENAME);
    await card.getByRole("link").first().click();
    await expect(page).toHaveURL(/\/photos\/\d+/);
    detailLocation = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;

    await expect(page.getByText(ORIGINAL_FILENAME, { exact: true })).toBeVisible();
    await expect(
      page.getByText("Aug 22, 2026, 2:30 PM · timezone not recorded"),
    ).toBeVisible();
    await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();
    await expectDecodedImage(page.getByRole("img", { name: "Unclassified" }));

    await page.getByRole("button", { name: "Edit metadata" }).click();
    await page.getByRole("textbox", { name: "Display title" }).fill(UPDATED_TITLE);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: UPDATED_TITLE })).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit metadata" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: UPDATED_TITLE })).toBeVisible();
    await expectDecodedImage(page.getByRole("img", { name: UPDATED_TITLE }));
    await page.getByRole("link", { name: "Back to catalog" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(catalogCard(page, UPDATED_TITLE)).toHaveCount(1);
  });

  await test.step("archive and detail location maps", async () => {
    await page.route(
      /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "image/png",
          body: TRANSPARENT_PNG,
        }),
    );

    await page.getByRole("link", { name: "Map", exact: true }).click();
    await expect(page).toHaveURL(/\/map$/);
    await expect(page.getByRole("heading", { name: "Photo Map" })).toBeVisible();
    const archiveMap = page.getByRole("region", {
      name: "Interactive archive map showing 1 geotagged photo",
    });
    await expect(archiveMap).toBeVisible();
    await archiveMap
      .getByRole("button", {
        name: `Open map preview for ${UPDATED_TITLE}`,
      })
      .click();
    await expectDecodedImage(
      archiveMap.getByRole("img", { name: UPDATED_TITLE }),
    );
    await archiveMap.getByRole("link", { name: "Open photo" }).click();

    await expect(page).toHaveURL(/\/photos\/\d+\?returnTo=%2Fmap%3Fphoto%3D\d+/);
    await expect(page.getByText("46.12345, 14.54321")).toBeVisible();
    await expect(
      page.getByRole("region", {
        name: `Interactive map showing the location of ${UPDATED_TITLE}`,
      }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to catalog" }).click();
    await expect(page).toHaveURL(/\/map\?photo=\d+$/);
    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(catalogCard(page, UPDATED_TITLE)).toHaveCount(1);
  });

  await test.step("Trash restore and permanent deletion", async () => {
    await catalogCard(page, UPDATED_TITLE).getByRole("link").first().click();
    await expect(page.getByRole("heading", { name: UPDATED_TITLE })).toBeVisible();

    await page.getByRole("button", { name: "Move to Trash" }).click();
    const detailTrashDialog = page.getByRole("dialog", {
      name: "Move photo to Trash",
    });
    const detailTrashSubmit = detailTrashDialog.getByRole("button", {
      name: "Move to Trash",
    });
    const detailConfirmation = detailTrashDialog.getByRole("textbox", {
      name: "Type the filename to confirm",
    });
    await expect(detailTrashSubmit).toBeDisabled();
    await detailConfirmation.fill("incorrect.jpg");
    await expect(detailTrashSubmit).toBeDisabled();
    await detailConfirmation.fill(ORIGINAL_FILENAME);
    await expect(detailTrashSubmit).toBeEnabled();
    await detailTrashSubmit.click();
    await expect(
      page.getByRole("heading", { name: "Start your animal archive" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Trash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trash", exact: true })).toBeVisible();
    const firstTrashCard = catalogCard(page, UPDATED_TITLE);
    await expect(firstTrashCard).toHaveCount(1);
    await expectDecodedImage(firstTrashCard.getByRole("img", { name: UPDATED_TITLE }));
    await firstTrashCard.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Trash is empty.")).toBeVisible();

    await page.getByRole("link", { name: "List", exact: true }).click();
    const restoredCard = catalogCard(page, UPDATED_TITLE);
    await expect(restoredCard).toHaveCount(1);
    await restoredCard.getByRole("button", { name: "Move to Trash" }).click();
    const catalogTrashDialog = page.getByRole("dialog", {
      name: "Move photo to Trash?",
    });
    await catalogTrashDialog.getByRole("button", { name: "Move to Trash" }).click();
    await expect(
      page.getByRole("heading", { name: "Start your animal archive" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Trash", exact: true }).click();
    const finalTrashCard = catalogCard(page, UPDATED_TITLE);
    await expect(finalTrashCard).toHaveCount(1);
    await finalTrashCard
      .getByRole("button", { name: "Permanently delete" })
      .click();
    const permanentDialog = page.getByRole("dialog", {
      name: "Permanently delete photo?",
    });
    const permanentSubmit = permanentDialog.getByRole("button", {
      name: "Permanently delete",
    });
    const permanentConfirmation = permanentDialog.getByRole("textbox", {
      name: "Filename confirmation",
    });
    await expect(permanentSubmit).toBeDisabled();
    await permanentConfirmation.fill("incorrect.jpg");
    await expect(permanentSubmit).toBeDisabled();
    await permanentConfirmation.fill(ORIGINAL_FILENAME);
    await expect(permanentSubmit).toBeEnabled();
    await permanentSubmit.click();
    await expect(page.getByText("Trash is empty.")).toBeVisible();
    await expect(catalogCard(page, UPDATED_TITLE)).toHaveCount(0);

    await page.goto(detailLocation);
    await expect(page.getByRole("heading", { name: "Photo not found" })).toBeVisible();

    const database = await stat(path.join(testRoot(), "data", "faunavault.db"));
    expect(database.isFile()).toBe(true);
    for (const directory of [
      "original",
      "resized",
      "thumbs",
      ".staging",
      ".purge",
    ]) {
      await expect
        .poll(async () =>
          (await readdir(path.join(testRoot(), "images", directory))).length,
        )
        .toBe(0);
    }
  });

  await test.step("Collections preserve photos before bulk Trash", async () => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Start your animal archive" }),
    ).toBeVisible();
    await uploadFile(page, BULK_FIRST_FILENAME);
    await expect(uploadRow(page, BULK_FIRST_FILENAME)).toContainText("Uploaded");
    await uploadFile(page, BULK_SECOND_FILENAME);
    await expect(uploadRow(page, BULK_SECOND_FILENAME)).toContainText("Uploaded");
    await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
    await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(1);

    await test.step("Smart Collection follows metadata changes", async () => {
      await catalogCard(page, BULK_FIRST_FILENAME).getByRole("link").first().click();
      await page.getByRole("button", { name: "Edit metadata" }).click();
      await page.getByRole("textbox", { name: "Category" }).fill("bird");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit metadata" })).toBeEnabled();
      await page.getByRole("button", { name: "Favorite", exact: true }).click();
      await expect(page.getByRole("button", { name: "Favorite", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.locator("label").filter({ has: page.getByRole("radio", { name: "Rate 5 stars" }) }).click();
      await expect(page.getByText("5 out of 5 stars", { exact: true })).toBeVisible();
      await page.getByRole("radio", { name: "Rate 5 stars" }).press("ArrowLeft");
      await expect(page.getByText("4 out of 5 stars", { exact: true })).toBeVisible();
      await page.getByRole("radio", { name: "Rate 4 stars" }).press("ArrowRight");
      await expect(page.getByText("5 out of 5 stars", { exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await page.getByRole("combobox", { name: "Category" }).selectOption("bird");
      await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("bird");
      await page.getByRole("checkbox", { name: "Favorites only" }).click();
      await expect(page.getByRole("checkbox", { name: "Favorites only" })).toBeChecked();
      await page.getByRole("combobox", { name: "Rating filter" }).selectOption("min:4");
      await expect(page.getByRole("combobox", { name: "Rating filter" })).toHaveValue("min:4");
      await page.reload();
      await expect(page.getByRole("checkbox", { name: "Favorites only" })).toBeChecked();
      await expect(page.getByRole("combobox", { name: "Rating filter" })).toHaveValue("min:4");
      await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
      await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(0);
      await page.getByRole("button", { name: "Save as Smart Collection" }).click();
      const dialog = page.getByRole("dialog", { name: "Create Smart Collection" });
      await dialog.getByRole("textbox", { name: "Smart Collection name" }).fill(SMART_COLLECTION_NAME);
      await dialog.getByRole("button", { name: "Create Smart Collection" }).click();
      await expect(page).toHaveURL(/\/collections\/smart\/\d+$/);
      await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
      await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(0);
      await catalogCard(page, BULK_FIRST_FILENAME).getByRole("link").first().click();
      await page.getByRole("button", { name: "Edit metadata" }).click();
      await page.getByRole("textbox", { name: "Category" }).fill("mammal");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Edit metadata" })).toBeEnabled();
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await expect(page.getByRole("heading", { name: "No matching photos" })).toBeVisible();
      await page.getByRole("link", { name: "List", exact: true }).click();
      await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
    });

    await page.getByRole("link", { name: "Collections", exact: true }).click();
    await page.getByRole("button", { name: "Create Collection" }).click();
    const nameDialog = page.getByRole("dialog", { name: "Create Collection" });
    await nameDialog.getByRole("textbox", { name: "Collection name" }).fill(COLLECTION_NAME);
    await nameDialog.getByRole("button", { name: "Create Collection" }).click();
    await expect(page.getByRole("heading", { name: COLLECTION_NAME })).toBeVisible();

    await page.getByRole("link", { name: "List", exact: true }).click();
    await page.getByRole("button", { name: "Select photos" }).click();
    const photoCheckboxes = page.getByRole("checkbox", {
      name: /Select photo \d+: Unclassified/,
    });
    await expect(photoCheckboxes).toHaveCount(2);
    await photoCheckboxes.nth(0).check();
    await photoCheckboxes.nth(1).check();
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add to Collection", exact: true }).click();
    const addDialog = page.getByRole("dialog", { name: "Add 2 photos to Collection" });
    await addDialog.getByRole("radio", { name: new RegExp(COLLECTION_NAME) }).check();
    await addDialog.getByRole("button", { name: "Add to Collection" }).click();
    await expect(page.getByText("Added 2 photos to the Collection.")).toBeVisible();

    await page.getByRole("link", { name: "Collections", exact: true }).click();
    await page.getByRole("link", { name: new RegExp(COLLECTION_NAME) }).click();
    await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
    await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(1);
    await page.getByRole("button", { name: "Delete Collection" }).click();
    const deleteDialog = page.getByRole("dialog", {
      name: `Delete collection “${COLLECTION_NAME}”?`,
    });
    await expect(deleteDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await deleteDialog.getByRole("button", { name: "Delete Collection" }).click();
    await expect(page).toHaveURL(/\/collections$/);

    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
    await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(1);
    await page.getByRole("button", { name: "Select photos" }).click();
    await page.getByRole("checkbox", { name: "Select page" }).check();
    await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Move to Trash" }).click();
    const bulkDialog = page.getByRole("dialog", {
      name: "Move 2 photos to Trash?",
    });
    await bulkDialog.getByRole("button", { name: "Move to Trash" }).click();

    await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(0);
    await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(0);
    await page.getByRole("link", { name: "Trash", exact: true }).click();
    await expect(catalogCard(page, BULK_FIRST_FILENAME)).toHaveCount(1);
    await expect(catalogCard(page, BULK_SECOND_FILENAME)).toHaveCount(1);
  });
});

test("Recent Imports preserves one batch through reload and scoped Culling", async ({ page, request }) => {
  const filenames = ["faunavault-e2e-import-81182.jpg", "faunavault-e2e-import-81183.jpg"];
  let sessionId: string | null = null;
  try {
    await page.goto("/");
    await page.getByLabel("Add to collection", { exact: false }).setInputFiles(filenames.map(fixturePath));
    await page.getByRole("button", { name: "Upload photos", exact: true }).click();
    for (const filename of filenames) await expect(uploadRow(page, filename)).toContainText("Uploaded");
    const summary = page.getByRole("region", { name: "Import Session" });
    await expect(summary).toContainText("Completed");
    await expect(summary).toContainText("2 imported originally · 2 active / 0 in Trash");
    const href = await summary.getByRole("link", { name: "View imported photos" }).getAttribute("href");
    sessionId = new URL(href!, "http://localhost").searchParams.get("catalog_import_session_id");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    await summary.getByRole("link", { name: "View imported photos" }).click();
    await expect(page).toHaveURL(new RegExp(`catalog_import_session_id=${sessionId}`));
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.reload();
    for (const filename of filenames) await expect(catalogCard(page, filename)).toHaveCount(1);
    await expect(page.getByRole("article")).toHaveCount(2);
    await page.getByRole("region", { name: "Import Session" }).getByRole("link", { name: "Cull this import" }).click();
    await expect(page).toHaveURL(/source=list/);
    await expect(page.getByRole("heading", { name: filenames[1] })).toBeVisible();
    await page.getByRole("button", { name: "Pick (P)" }).click();
    await expect(page.getByRole("heading", { name: filenames[0] })).toBeVisible();
    await page.getByRole("button", { name: "Reject (X)" }).click();
    await expect(page.getByRole("region", { name: "Import Session" })).toContainText("0 undecided · 1 Pick · 1 Reject");
    await expect(page.getByRole("link", { name: "Review rejected", exact: true })).toHaveAttribute("href", new RegExp(`catalog_import_session_id=${sessionId}.*catalog_culling_state=reject|catalog_culling_state=reject.*catalog_import_session_id=${sessionId}`));
    await page.getByRole("link", { name: "Back to List", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`catalog_import_session_id=${sessionId}`));
    await expect(page.getByRole("region", { name: "Import Session" })).toContainText("0 undecided · 1 Pick · 1 Reject");
    await page.getByRole("link", { name: "Recent Imports", exact: true }).first().click();
    const history = page.getByRole("region", { name: "Import Session" }).filter({ has: page.locator(`a[href*="catalog_import_session_id=${sessionId}"]`) });
    await expect(history).toHaveCount(1);
    await expect(history).toContainText("0 undecided · 1 Pick · 1 Reject");
    await page.screenshot({ path: test.info().outputPath("imports-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("imports-mobile.png"), fullPage: true });
  } finally {
    if (sessionId) {
      const result = await request.get(`http://127.0.0.1:8001/catalog/photos?import_session_id=${sessionId}`);
      for (const photo of (await result.json()).items) {
        await request.delete(`http://127.0.0.1:8001/photos/${photo.id}`);
        await request.delete(`http://127.0.0.1:8001/trash/photos/${photo.id}`);
      }
    }
  }
});

test("Photo Culling saves independent decisions and filters Picks", async ({ page, request }) => {
  const filenames = ["faunavault-e2e-culling-reject.jpg", "faunavault-e2e-culling-pick.jpg"];
  const ids: number[] = [];
  try {
    for (const filename of filenames) {
      const uploaded = await request.post("http://127.0.0.1:8001/photos/upload", {
        multipart: { file: { name: filename, mimeType: "image/jpeg", buffer: await readFile(fixturePath(filename)) }, allow_visual_duplicate: "true" },
      });
      expect(uploaded.ok()).toBe(true);
      ids.push((await uploaded.json()).id);
    }
    await page.goto("/cull?catalog_search=faunavault-e2e-culling");
    await expect(page.getByRole("heading", { name: "Photo Culling" })).toBeVisible();
    await expect(page.getByRole("heading", { name: filenames[1] })).toBeVisible();
    await expectDecodedImage(page.getByRole("img", { name: "Unclassified" }));
    await page.screenshot({ path: test.info().outputPath("culling-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Pick (P)" }).click();
    await expect(page.getByRole("heading", { name: filenames[0] })).toBeVisible();
    await page.getByRole("button", { name: "Reject (X)" }).click();
    await expect(page.getByRole("button", { name: "Reject (X)" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/End of pass · 0 still match/)).toBeVisible();
    await page.getByRole("button", { name: "← Previous" }).click();
    await expect(page.getByRole("heading", { name: filenames[1] })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pick (P)" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Saved: Rejected. End of pass.", { exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("culling-mobile.png"), fullPage: true });
    await page.goto("/?catalog_search=faunavault-e2e-culling");
    await page.getByRole("combobox", { name: "Culling filter" }).selectOption("pick");
    await expect(page).toHaveURL(/catalog_culling_state=pick/);
    await expect(catalogCard(page, filenames[1])).toHaveCount(1);
    await expect(catalogCard(page, filenames[0])).toHaveCount(0);
    await page.reload();
    await expect(catalogCard(page, filenames[1])).toHaveCount(1);
    const rejected = await request.get(`http://127.0.0.1:8001/photos/${ids[0]}`);
    expect(await rejected.json()).toMatchObject({ culling_state: "reject", deleted_at: null, is_favorite: false, rating: null, reviewed_at: null });
  } finally {
    for (const id of ids) {
      await request.delete(`http://127.0.0.1:8001/photos/${id}`);
      await request.delete(`http://127.0.0.1:8001/trash/photos/${id}`);
    }
  }
});

test("rejected review moves explicit selection to recoverable Trash and Compare updates membership", async ({ page, request }, testInfo) => {
  const filenames = ["faunavault-e2e-cleanup-first.jpg", "faunavault-e2e-cleanup-second.jpg"];
  const ids: number[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const uploaded = await request.post("http://127.0.0.1:8001/photos/upload", {
        multipart: { file: { name: filenames[index], mimeType: "image/jpeg", buffer: await readFile(fixturePath(index === 0 ? "faunavault-e2e-culling-reject.jpg" : "faunavault-e2e-culling-pick.jpg")) }, allow_visual_duplicate: "true" },
      });
      expect(uploaded.ok()).toBe(true);
      ids.push((await uploaded.json()).id);
    }
    await page.goto("/cull?catalog_search=faunavault-e2e-cleanup");
    await expect(page.getByRole("heading", { name: filenames[1] })).toBeVisible();
    await page.getByRole("button", { name: "Reject (X)" }).click();
    await expect(page.getByRole("heading", { name: filenames[0] })).toBeVisible();
    await page.getByRole("button", { name: "Reject (X)" }).click();
    await expect(page.getByText(/End of pass · 0 still match/)).toBeVisible();
    await page.getByRole("link", { name: "Review rejected", exact: true }).click();
    await expect(page).toHaveURL(/\/\?catalog_culling_state=reject$/);
    await expect(page.getByText("2 rejected photos", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Move to Trash", exact: true })).toHaveCount(0);
    await page.getByRole("searchbox").fill("no-cleanup-match");
    await expect(page.getByRole("heading", { name: "No rejected photos match these filters" })).toBeVisible();
    // A pending debounced search must not overwrite the all-Reject entry URL.
    await page.getByRole("searchbox").fill("another-cleanup-miss");
    await page.getByRole("link", { name: "Review all rejected photos", exact: true }).click();
    await expect(page).toHaveURL(/\/\?catalog_culling_state=reject$/);
    await expect(page.getByText("2 rejected photos", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select photos", exact: true }).click();
    await expect(page.getByRole("button", { name: "Move 0 selected photos to Trash" })).toBeDisabled();
    const checkbox = page.getByRole("checkbox", { name: new RegExp(`Select photo ${ids[0]}:`) });
    await checkbox.focus();
    await checkbox.press("Space");
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Move 1 selected photo to Trash" }).click();
    const dialog = page.getByRole("dialog", { name: "Move 1 selected photo to Trash?" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog).toContainText("can be restored later");
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("rejected-confirmation-mobile.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Move selected to Trash" }).click();
    await expect(page.getByText("1 rejected photo", { exact: true })).toBeVisible();
    await expect(catalogCard(page, filenames[0])).toHaveCount(0);
    await expect(catalogCard(page, filenames[1])).toHaveCount(1);
    await page.getByRole("link", { name: "Trash", exact: true }).click();
    await catalogCard(page, filenames[0]).getByRole("button", { name: "Restore", exact: true }).click();
    await expect(catalogCard(page, filenames[0])).toHaveCount(0);
    await page.getByRole("link", { name: "List", exact: true }).click();
    await expect(page.getByText("2 rejected photos", { exact: true })).toBeVisible();
    await expect(catalogCard(page, filenames[0])).toHaveCount(1);
    await page.reload();
    await expect(page.getByText("2 rejected photos", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Select photos", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select page", exact: true }).check();
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.getByRole("button", { name: "Pick left photo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pick left photo", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("link", { name: "Back to List", exact: true }).click();
    await expect(page.getByText("1 rejected photo", { exact: true })).toBeVisible();
    await expect(catalogCard(page, filenames[0])).toHaveCount(0);
    await expect(catalogCard(page, filenames[1])).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("rejected-review-mobile.png"), fullPage: true });
  } finally {
    for (const id of ids) {
      await request.delete(`http://127.0.0.1:8001/photos/${id}`);
      await request.delete(`http://127.0.0.1:8001/trash/photos/${id}`);
    }
  }
});

test("HEIC upload produces browser-safe JPEG previews", async ({ page }) => {
  await page.goto("/");
  await uploadFile(page, HEIC_FILENAME);
  await expect(uploadRow(page, HEIC_FILENAME)).toContainText("Uploaded");

  const card = catalogCard(page, HEIC_FILENAME);
  await expect(card).toHaveCount(1);
  const thumbnail = card.getByRole("img", { name: "Unclassified" });
  await expectDecodedImage(thumbnail);
  const thumbnailUrl = await thumbnail.getAttribute("src");
  expect(thumbnailUrl).toBeTruthy();
  const thumbnailResponse = await page.request.get(
    new URL(thumbnailUrl!, page.url()).toString(),
  );
  expect(thumbnailResponse.ok()).toBe(true);
  expect(thumbnailResponse.headers()["content-type"]).toContain("image/jpeg");

  await card.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/photos\/\d+/);
  await expect(page.getByText(HEIC_FILENAME, { exact: true })).toBeVisible();
  await expect(page.getByText("Apple iPhone Test", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic HEIC Lens", { exact: true })).toBeVisible();
  await expectDecodedImage(page.getByRole("img", { name: "Unclassified" }));
});

test("Timeline groups capture months and opens the filtered List", async ({ page }) => {
  await page.goto("/");
  await uploadFile(page, TIMELINE_JANUARY_FILENAME);
  await expect(uploadRow(page, TIMELINE_JANUARY_FILENAME)).toContainText("Uploaded");
  await uploadFile(page, TIMELINE_FEBRUARY_FILENAME);
  await expect(uploadRow(page, TIMELINE_FEBRUARY_FILENAME)).toContainText("Uploaded");

  await page.getByRole("link", { name: "Timeline", exact: true }).click();
  await expect(page).toHaveURL(/\/timeline$/);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "2024", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "2023", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View 1 photo from February 2024" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View 1 photo from January 2023" }),
  ).toBeVisible();
  await expectDecodedImage(
    page.getByRole("img", { name: TIMELINE_FEBRUARY_FILENAME }),
  );
  await expectDecodedImage(
    page.getByRole("img", { name: TIMELINE_JANUARY_FILENAME }),
  );

  for (const viewport of [
    { width: 360, height: 760 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }

  await page
    .getByRole("link", { name: "View 1 photo from February 2024" })
    .click();
  await expect(page).toHaveURL(/\/\?catalog_taken_from=/);
  const listUrl = new URL(page.url());
  expect(Object.fromEntries(listUrl.searchParams)).toEqual({
    catalog_taken_from: "2024-02-01",
    catalog_taken_to: "2024-02-29",
    catalog_sort: "captured_at",
    catalog_order: "desc",
  });
  await expect(page.getByLabel("Taken from")).toHaveValue("2024-02-01");
  await expect(page.getByLabel("Taken to")).toHaveValue("2024-02-29");
  await expect(catalogCard(page, TIMELINE_FEBRUARY_FILENAME)).toHaveCount(1);
  await expect(catalogCard(page, TIMELINE_JANUARY_FILENAME)).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/timeline$/);
  await expect(page.getByRole("heading", { name: "Timeline" })).toBeVisible();
});

test("two-photo Compare saves curation, restores URLs, zooms independently and switches on mobile", async ({ page, request }, testInfo) => {
  const filenames = ["faunavault-e2e-compare-left.jpg", "faunavault-e2e-compare-right.jpg"];
  const ids: number[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const uploaded = await request.post("http://127.0.0.1:8001/photos/upload", {
        multipart: { file: { name: filenames[index], mimeType: "image/jpeg", buffer: await readFile(fixturePath(index === 0 ? "faunavault-e2e-culling-reject.jpg" : "faunavault-e2e-culling-pick.jpg")) }, allow_visual_duplicate: "true" },
      });
      expect(uploaded.ok()).toBe(true); ids.push((await uploaded.json()).id);
    }
    await page.goto("/?catalog_search=faunavault-e2e-compare");
    await page.getByRole("button", { name: "Select photos", exact: true }).click();
    const compare = page.getByRole("button", { name: "Compare", exact: true });
    await expect(compare).toBeDisabled();
    await page.getByRole("checkbox", { name: new RegExp(`Select photo ${ids[1]}:`) }).check();
    await expect(compare).toBeDisabled();
    await page.getByRole("checkbox", { name: new RegExp(`Select photo ${ids[0]}:`) }).check();
    await expect(compare).toBeEnabled(); await compare.click();
    await expect(page).toHaveURL(/\/compare\?left=/);
    const pairUrl = page.url();
    const originals: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/images/original/")) originals.push(request.url()); });
    await page.reload();
    const left = page.getByRole("region", { name: "Left photo", exact: true });
    const right = page.getByRole("region", { name: "Right photo", exact: true });
    await expectDecodedImage(left.getByRole("img")); await expectDecodedImage(right.getByRole("img"));
    expect(originals).toHaveLength(0);
    await page.getByRole("button", { name: "Zoom in left photo" }).click();
    await expect(page.getByLabel("left photo zoom", { exact: true })).toHaveText("1.5× fit");
    await expect(page.getByLabel("right photo zoom", { exact: true })).toHaveText("Fit");
    await page.getByRole("button", { name: "Pan left photo right" }).click();
    await expect.poll(() => page.getByRole("region", { name: "left photo image viewport" }).evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Fit / reset left photo" }).click();
    await page.getByRole("button", { name: "Load left photo original resolution" }).click();
    await expect(left.getByRole("img")).toHaveAttribute("src", /\/images\/original\//);
    await expectDecodedImage(left.getByRole("img"));
    expect(originals.length).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("compare-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Pick left photo", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pick left photo", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Favorite right photo" }).click();
    await expect(page.getByRole("button", { name: "Favorite right photo" })).toHaveAttribute("aria-pressed", "true");
    await page.locator("label").filter({ has: page.getByRole("radio", { name: "Rate right photo 4 stars" }) }).click();
    await expect(page.getByRole("radio", { name: "Rate right photo 4 stars" })).toBeChecked();
    await page.setViewportSize({ width: 360, height: 760 });
    await page.getByRole("button", { name: "Focus left photo" }).click();
    await expect(left).toBeVisible(); await expect(right).toBeHidden();
    await page.getByRole("button", { name: "Focus right photo" }).click();
    await expect(right).toBeVisible(); await expect(left).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("compare-mobile.png"), fullPage: true });
    await page.getByRole("link", { name: "Back to List" }).click();
    await expect(page).toHaveURL(/catalog_search=faunavault-e2e-compare/);
    await expect(page.getByRole("button", { name: "Select photos", exact: true })).toBeVisible();
    await expect(catalogCard(page, filenames[0]).getByLabel("Picked")).toBeVisible();
    await expect(catalogCard(page, filenames[1]).getByLabel("Favorite", { exact: true })).toBeVisible();
    await expect(catalogCard(page, filenames[1]).getByLabel("Rated 4 out of 5 stars")).toBeVisible();
    await page.goBack(); await expect(page).toHaveURL(pairUrl);
    await page.goForward(); await expect(page).toHaveURL(/catalog_search=faunavault-e2e-compare/);
    const savedLeft = await request.get(`http://127.0.0.1:8001/photos/${ids[0]}`);
    const savedRight = await request.get(`http://127.0.0.1:8001/photos/${ids[1]}`);
    expect(await savedLeft.json()).toMatchObject({ culling_state: "pick", is_favorite: false, rating: null });
    expect(await savedRight.json()).toMatchObject({ culling_state: null, is_favorite: true, rating: 4 });
  } finally {
    for (const id of ids) { await request.delete(`http://127.0.0.1:8001/photos/${id}`); await request.delete(`http://127.0.0.1:8001/trash/photos/${id}`); }
  }
});

test("persistent visual duplicate review", async ({ page, request }) => {
  const ids: number[] = [];
  try {
    for (const filename of [ORIGINAL_FILENAME, RECOMPRESSED_FILENAME]) {
      const uploaded = await request.post("http://127.0.0.1:8001/photos/upload", {
        multipart: { file: { name: filename, mimeType: "image/jpeg", buffer: await readFile(fixturePath(filename)) }, allow_visual_duplicate: "true" },
      });
      expect(uploaded.ok()).toBe(true);
      ids.push((await uploaded.json()).id);
    }
    await page.goto(`/duplicates?left=${ids[0]}&right=${ids[1]}`);
    await expect(page.getByRole("heading", { name: "Duplicate Review Center" })).toBeVisible();
    await expect(page.getByText(/Fingerprint distance \d; review threshold 4/)).toBeVisible();
    await expectDecodedImage(page.getByRole("region", { name: "Left photo" }).getByRole("img"));
    await expectDecodedImage(page.getByRole("region", { name: "Right photo" }).getByRole("img"));
    await page.screenshot({ path: test.info().outputPath("duplicates-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath("duplicates-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Keep both / Not duplicates" }).click();
    await expect(page.getByRole("heading", { name: "No possible duplicates need review." })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "No possible duplicates need review." })).toBeVisible();
    const summary = await request.get("http://127.0.0.1:8001/duplicates/summary");
    expect((await summary.json()).dismissed).toBe(1);
  } finally {
    for (const id of ids) {
      await request.delete(`http://127.0.0.1:8001/photos/${id}`);
      await request.delete(`http://127.0.0.1:8001/trash/photos/${id}`);
    }
  }
});


test("manual capture and GPS correction drives Timeline and Map", async ({ page, request }) => {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  await page.goto("/");
  await uploadFile(page, CAPTURE_EDIT_FILENAME);
  await expect(uploadRow(page, CAPTURE_EDIT_FILENAME)).toContainText("Uploaded");
  await catalogCard(page, CAPTURE_EDIT_FILENAME).getByRole("link").first().click();
  await expect(page.getByRole("button", { name: "Edit metadata" })).toBeVisible();
  const detailPath = new URL(page.url()).pathname;
  const id = detailPath.split("/").pop();
  try {
    await expect(page.getByRole("link", { name: "View on map" })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit metadata" }).click();
    await page.getByLabel("Capture date/time").fill("2025-03-14T23:45:12");
    await page.getByLabel("UTC offset").fill("-05:30");
    await page.getByLabel("Latitude", { exact: true }).fill("46.123456789");
    await page.getByLabel("Longitude", { exact: true }).fill("14.987654321");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit metadata" })).toBeVisible();
    await expect(page.getByText(/UTC−05:30 · Manually edited/)).toBeVisible();
    await page.goto("/timeline");
    await expect(page.getByRole("link", { name: "View 1 photo from March 2025" })).toBeVisible();
    await expectDecodedImage(page.getByRole("img", { name: CAPTURE_EDIT_FILENAME }));
    await page.goto(`/map?photo=${id}`);
    const point = page.getByRole("button", { name: `Open map preview for ${CAPTURE_EDIT_FILENAME}` });
    await expect(point).toBeVisible();
    await point.click();
    await page.getByRole("link", { name: "Open photo", exact: true }).click();
    await expect(page.getByText("46.12346, 14.98765 · Manually edited")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Edit metadata" }).click();
    await expect(page.getByLabel("Capture date/time")).toHaveValue("2025-03-14T23:45:12");
    await expect(page.getByLabel("UTC offset")).toHaveValue("-05:30");
    await expect(page.getByLabel("Latitude", { exact: true })).toHaveValue("46.123456789");
    await expect(page.getByLabel("Longitude", { exact: true })).toHaveValue("14.987654321");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await request.delete(`http://127.0.0.1:8001/photos/${id}`);
    await request.delete(`http://127.0.0.1:8001/trash/photos/${id}`);
  }
});


test("Map filters restore and open equivalent List including missing-GPS photos", async ({ page, request }, testInfo) => {
  await page.route(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: TRANSPARENT_PNG }));
  const photoIds: number[] = [];
  const names = [TIMELINE_JANUARY_FILENAME, TIMELINE_FEBRUARY_FILENAME, CAPTURE_EDIT_FILENAME];
  try {
    for (const [index, filename] of names.entries()) {
      const upload = await request.post("http://127.0.0.1:8001/photos/upload", {
        multipart: { allow_visual_duplicate: "true", file: { name: `map-filter-${index}.jpg`, mimeType: "image/jpeg", buffer: Buffer.concat([await readFile(fixturePath(filename)), Buffer.from(`map-filter-fixture-${index}`)]) } },
      });
      expect(upload.ok()).toBe(true);
      const photo = await upload.json();
      photoIds.push(photo.id);
      const update = await request.patch(`http://127.0.0.1:8001/photos/${photo.id}?expected_updated_at=${encodeURIComponent(photo.updated_at)}`, {
        data: { category: index === 1 ? "mammal" : "bird", captured_at: index === 1 ? "2025-01-01T12:00:00" : "2026-01-01T12:00:00",
          captured_at_offset_minutes: -600, latitude: index === 2 ? null : 46 + index, longitude: index === 2 ? null : 14 + index },
      });
      expect(update.ok()).toBe(true);
    }
    await page.goto("/map");
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("combobox", { name: "Category", exact: true }).selectOption("bird");
    await page.getByLabel("Taken from", { exact: true }).fill("2026-01-01");
    await page.getByLabel("Taken to", { exact: true }).fill("2026-01-31");
    await expect(page.getByText("1 mapped photo", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open map preview for map-filter-0.jpg" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open map preview for map-filter-1.jpg" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("filtered-map-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("region", { name: "Interactive archive map showing 1 geotagged photo" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Open map preview for map-filter-0.jpg" })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("filtered-map-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.reload();
    await expect(page.getByText("1 mapped photo", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open map preview for map-filter-0.jpg" }).click();
    await page.getByRole("link", { name: "Open photo", exact: true }).click();
    await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
    await page.getByLabel("Latitude", { exact: true }).fill("45");
    await page.getByLabel("Longitude", { exact: true }).fill("13");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit metadata", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Back to catalog", exact: true }).click();
    await expect(page).toHaveURL(/catalog_category=bird/);
    await expect(page.getByText("1 mapped photo", { exact: true })).toBeVisible();
    const points = await request.get("http://127.0.0.1:8001/catalog/map?category=bird&taken_from=2026-01-01&taken_to=2026-01-31");
    expect((await points.json()).map((point: { latitude: number }) => point.latitude)).toEqual([45]);
    await page.getByRole("link", { name: "View in List", exact: true }).click();
    await expect(page).toHaveURL(/\/\?catalog_category=bird&catalog_taken_from=2026-01-01&catalog_taken_to=2026-01-31$/);
    await expect(catalogCard(page, "map-filter-0.jpg")).toHaveCount(1);
    await expect(catalogCard(page, "map-filter-2.jpg")).toHaveCount(1);
    await expect(catalogCard(page, "map-filter-1.jpg")).toHaveCount(0);
    await page.getByRole("link", { name: "View on Map", exact: true }).click();
    await expect(page.getByText("1 mapped photo", { exact: true })).toBeVisible();
  } finally {
    for (const id of photoIds) {
      await request.delete(`http://127.0.0.1:8001/photos/${id}`);
      await request.delete(`http://127.0.0.1:8001/trash/photos/${id}`);
    }
  }
});
