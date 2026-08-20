import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

const E2E_ROOT_PREFIX = "faunavault-e2e-";
const FRONTEND_URL = "http://127.0.0.1:3001";
const BACKEND_URL = "http://127.0.0.1:8001";
const configDirectory = __dirname;
const backendDirectory = path.resolve(configDirectory, "../backend");

function requireOwnedTestRoot() {
  const configuredRoot = process.env.FAUNAVAULT_E2E_ROOT;
  if (!configuredRoot) {
    throw new Error("Run browser smoke coverage with npm run test:e2e.");
  }
  const testRoot = path.resolve(configuredRoot);
  if (
    path.dirname(testRoot) !== path.resolve(tmpdir()) ||
    !path.basename(testRoot).startsWith(E2E_ROOT_PREFIX)
  ) {
    throw new Error(`Refusing to use unowned E2E path: ${testRoot}`);
  }
  return testRoot;
}

function sqliteUrl(databasePath: string) {
  const normalizedPath = databasePath.replaceAll(path.sep, "/");
  return process.platform === "win32"
    ? `sqlite:///${normalizedPath}`
    : `sqlite:////${normalizedPath.replace(/^\/+/, "")}`;
}

const testRoot = requireOwnedTestRoot();
if (process.env.NEXT_PUBLIC_API_URL !== BACKEND_URL) {
  throw new Error(
    `NEXT_PUBLIC_API_URL must be ${BACKEND_URL} before the E2E production build.`,
  );
}

const dataDirectory = path.join(testRoot, "data");
const imageDirectory = path.join(testRoot, "images");
const backendEnvironment = {
  DATABASE_URL: sqliteUrl(path.join(dataDirectory, "faunavault.db")),
  DATA_DIR: dataDirectory,
  IMAGE_DIR: imageDirectory,
  OLLAMA_BASE_URL: "http://127.0.0.1:9",
  GBIF_BASE_URL: "http://127.0.0.1:9",
  MAX_UPLOAD_BYTES: String(5 * 1024 * 1024),
  MAX_IMAGE_PIXELS: String(2_000_000),
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  reporter: process.env.CI
    ? [
        ["line"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
      ]
    : [["line"]],
  use: {
    baseURL: FRONTEND_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      name: "Backend",
      command:
        "uv run --no-sync uvicorn app.main:app --host 127.0.0.1 --port 8001",
      cwd: backendDirectory,
      env: backendEnvironment,
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      name: "Frontend",
      command: "npm run start -- --hostname 127.0.0.1 --port 3001",
      cwd: configDirectory,
      url: FRONTEND_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
