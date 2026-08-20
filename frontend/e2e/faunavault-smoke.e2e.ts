import { expect, type Locator, type Page, test } from "@playwright/test";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const ORIGINAL_FILENAME = "faunavault-e2e-original.jpg";
const RECOMPRESSED_FILENAME = "faunavault-e2e-recompressed.jpg";
const UPDATED_TITLE = "FaunaVault E2E specimen";

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

    await page.getByRole("button", { name: "trash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Trash", exact: true })).toBeVisible();
    const firstTrashCard = catalogCard(page, UPDATED_TITLE);
    await expect(firstTrashCard).toHaveCount(1);
    await expectDecodedImage(firstTrashCard.getByRole("img", { name: UPDATED_TITLE }));
    await firstTrashCard.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("Trash is empty.")).toBeVisible();

    await page.getByRole("button", { name: "list", exact: true }).click();
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

    await page.getByRole("button", { name: "trash", exact: true }).click();
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
});
