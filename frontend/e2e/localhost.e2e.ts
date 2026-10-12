import { expect, test } from "@playwright/test";

for (const hostname of ["localhost", "127.0.0.1"]) {
  test(`frontend and backend remain accessible through ${hostname}`, async ({ page }) => {
    const response = await page.goto(`http://${hostname}:3001`);
    expect(response?.ok()).toBe(true);

    // A browser fetch also checks CORS for each supported loopback origin.
    const healthy = await page.evaluate(async (host) => {
      const health = await fetch(`http://${host}:8001/health`);
      return health.ok;
    }, hostname);
    expect(healthy).toBe(true);
  });
}
