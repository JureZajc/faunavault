import { expect, test } from "@playwright/test";
import { testPort } from "./ports.mjs";

for (const hostname of ["localhost", "127.0.0.1"]) {
  test(`frontend and backend remain accessible through ${hostname}`, async ({ page }) => {
    const response = await page.goto(`http://${hostname}:${testPort("FAUNAVAULT_E2E_FRONTEND_PORT", 3001)}`);
    expect(response?.ok()).toBe(true);

    // A browser fetch also checks CORS for each supported loopback origin.
    const healthy = await page.evaluate(async ({ host, port }) => {
      const health = await fetch(`http://${host}:${port}/health`);
      return health.ok;
    }, { host: hostname, port: testPort("FAUNAVAULT_E2E_BACKEND_PORT", 8001) });
    expect(healthy).toBe(true);
  });
}
