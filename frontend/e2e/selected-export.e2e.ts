import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { backend } from "./urls";

for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 360, height: 760 }]) {
  test(`selected original export ${viewport.name}: confirm, recover, native download`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const root = process.env.FAUNAVAULT_E2E_ROOT;
    if (!root) throw new Error("Run with npm run test:e2e for disposable storage.");
    const source = await readFile(path.join(root, "fixtures", "faunavault-e2e-capture-edit.jpg"));
    const ids: number[] = [];
    const hashes: Record<string, string> = {};
    try {
      for (let index = 0; index < 3; index++) {
        const payload = Buffer.concat([source, Buffer.from(`selected-export-${viewport.name}-${index}`)]);
        const response = await request.post(`${backend}/photos/upload`, { multipart: {
          allow_visual_duplicate: "true",
          file: { name: `selected-export-${viewport.name}-${index}.jpg`, mimeType: "image/jpeg", buffer: payload },
        } });
        expect(response.ok()).toBe(true);
        const id = (await response.json()).id;
        ids.push(id);
        hashes[id] = createHash("sha256").update(payload).digest("hex");
      }
      const catalogUrl = `/?catalog_search=selected-export-${viewport.name}`;
      await page.goto(catalogUrl);
      await page.getByRole("button", { name: "Select photos", exact: true }).click();
      for (const id of ids.slice(0, 2)) await page.getByRole("checkbox", { name: new RegExp(`Select photo ${id}:`) }).check();
      const launch = page.getByRole("button", { name: "Export selected", exact: true });
      await launch.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await dialog.press("Escape");
      await expect(launch).toBeFocused();
      await launch.click();
      await dialog.getByRole("checkbox", { name: "Include metadata JSON manifest" }).check();
      await expect(dialog.getByRole("status")).toContainText("Estimated total download size");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`selected-export-${viewport.name}.png`) });

      // A failed preparation must retain configuration and explicit selection.
      await page.route(`${backend}/exports/selected`, async (route) => {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: { code: "export_photo_changed", message: "Selected photos changed. Retry." } }) });
      }, { times: 1 });
      await dialog.getByRole("button", { name: "Confirm and download ZIP" }).click();
      await expect(dialog.getByRole("alert")).toContainText("Selected photos changed");
      await expect(dialog.getByRole("checkbox")).toBeChecked();

      const downloadEvent = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Confirm and download ZIP" }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("FaunaVault-Export.zip");
      const zipPath = path.join(root, `selected-export-${viewport.name}.zip`);
      await download.saveAs(zipPath);
      expect(await download.failure()).toBeNull();
      // Verify the actual native download with Python's ZIP parser, including CRC,
      // manifest membership and original-byte checksums. The third match is excluded.
      execFileSync("uv", ["run", "--no-sync", "python", "-c", [
        "import hashlib,json,sys,zipfile",
        "expected=json.loads(sys.argv[2])",
        "z=zipfile.ZipFile(sys.argv[1])",
        "assert z.testzip() is None",
        "m=json.loads(z.read('metadata.json'))",
        "assert {str(p['id']) for p in m['photos']} == set(expected)",
        "assert len(z.namelist()) == len(expected)+1",
        "assert all(hashlib.sha256(z.read(p['zip_member_path'])).hexdigest() == p['original_sha256'] == expected[str(p['id'])] for p in m['photos'])",
      ].join("\n"), zipPath, JSON.stringify(Object.fromEntries(ids.slice(0, 2).map((id) => [id, hashes[id]])))], { cwd: path.resolve(process.cwd(), "../backend"), windowsHide: true });
      await expect(dialog.getByRole("status")).toContainText("Download requested");
      await dialog.getByRole("button", { name: "Done" }).click();
      await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("catalog_search")).toBe(`selected-export-${viewport.name}`);
      await expect(page.getByRole("checkbox", { name: new RegExp(`Select photo ${ids[2]}:`) })).not.toBeChecked();
    } finally {
      for (const id of ids) {
        await request.delete(`${backend}/photos/${id}`);
        await request.delete(`${backend}/trash/photos/${id}`);
      }
    }
  });
}
