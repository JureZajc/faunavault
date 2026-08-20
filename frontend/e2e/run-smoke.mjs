import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_ROOT_PREFIX = "faunavault-e2e-";
const BACKEND_URL = "http://127.0.0.1:8001";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(scriptDirectory, "..");
const backendDirectory = path.resolve(frontendDirectory, "../backend");
const require = createRequire(import.meta.url);

let activeChild = null;
let receivedSignal = null;

function recordSignal(signal) {
  receivedSignal ??= signal;
  if (activeChild?.exitCode === null && !activeChild.killed) {
    activeChild.kill(signal);
  }
}

process.once("SIGINT", () => recordSignal("SIGINT"));
process.once("SIGTERM", () => recordSignal("SIGTERM"));

function run(command, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) {
        resolve();
        return;
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} failed with ${outcome}.`));
    });
  });
}

function assertOwnedRoot(testRoot) {
  const resolvedRoot = path.resolve(testRoot);
  const resolvedTemporaryDirectory = path.resolve(tmpdir());
  if (
    path.dirname(resolvedRoot) !== resolvedTemporaryDirectory ||
    !path.basename(resolvedRoot).startsWith(E2E_ROOT_PREFIX)
  ) {
    throw new Error(`Refusing to remove unowned E2E path: ${resolvedRoot}`);
  }
  return resolvedRoot;
}

async function removeOwnedRoot(testRoot) {
  const ownedRoot = assertOwnedRoot(testRoot);
  await rm(ownedRoot, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 200,
  });
}

async function main() {
  const testRoot = await mkdtemp(
    path.join(path.resolve(tmpdir()), E2E_ROOT_PREFIX),
  );
  const environment = {
    ...process.env,
    FAUNAVAULT_E2E_ROOT: testRoot,
    NEXT_PUBLIC_API_URL: BACKEND_URL,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  let failure = null;

  try {
    await run(
      "uv",
      [
        "run",
        "--no-sync",
        "python",
        path.join(scriptDirectory, "generate-fixtures.py"),
        testRoot,
      ],
      { cwd: backendDirectory, env: environment },
    );
    await run(
      process.execPath,
      [require.resolve("next/dist/bin/next"), "build"],
      { cwd: frontendDirectory, env: environment },
    );
    await run(
      process.execPath,
      [require.resolve("@playwright/test/cli"), "test", ...process.argv.slice(2)],
      { cwd: frontendDirectory, env: environment },
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      await removeOwnedRoot(testRoot);
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError([failure, cleanupError], "E2E run and cleanup failed.")
        : cleanupError;
    }
  }

  if (failure) throw failure;
}

try {
  await main();
} catch (error) {
  if (!receivedSignal) console.error(error);
  process.exitCode = receivedSignal === "SIGINT" ? 130 : receivedSignal ? 143 : 1;
}
