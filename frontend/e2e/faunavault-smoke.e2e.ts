import { expect, type Locator, type Page, test } from "@playwright/test";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const ORIGINAL_FILENAME = "faunavault-e2e-original.jpg";
const RECOMPRESSED_FILENAME = "faunavault-e2e-recompressed.jpg";
const UPDATED_TITLE = "FaunaVault E2E specimen";
const BULK_FIRST_FILENAME = "faunavault-e2e-bulk-first.jpg";
const BULK_SECOND_FILENAME = "faunavault-e2e-bulk-second.jpg";
const HEIC_FILENAME = "faunavault-e2e-iphone.heic";
const TIMELINE_JANUARY_FILENAME = "faunavault-e2e-timeline-january.jpg";
const TIMELINE_FEBRUARY_FILENAME = "faunavault-e2e-timeline-february.jpg";
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
      await page.getByRole("link", { name: "Back to catalog" }).click();
      await page.getByRole("combobox", { name: "Category" }).selectOption("bird");
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
