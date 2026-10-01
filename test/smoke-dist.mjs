/**
 * Post-build smoke test.
 *
 * Vitest runs against TypeScript sources, where module resolution always sees a
 * native CommonJS require. The published bundles are consumed from packed
 * Electron/Node apps, so this script exercises the built ESM entry the same way
 * and guarantees the tree-sitter runtime still resolves after bundling.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { scanProject } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const distEntry = pathToFileURL(join(here, "..", "dist", "index.js")).href;

const cases = [
  { dir: "laravel-php", framework: "laravel", minRoutes: 10, includeTests: true },
  { dir: "axum-rs", framework: "axum", minRoutes: 1, includeTests: true },
  { dir: "spring-java", framework: "spring", minRoutes: 1, includeTests: true },
  { dir: "aspnet-csharp", framework: "aspnet", minRoutes: 1, includeTests: true },
];

for (const testCase of cases) {
  const result = await scanProject({
    root: join(fixtures, testCase.dir),
    includeTests: testCase.includeTests,
  });
  assert.ok(
    result.report.frameworks.includes(testCase.framework),
    `${testCase.dir}: expected framework ${testCase.framework}, got ${result.report.frameworks}`,
  );
  assert.ok(
    result.project.operations.length >= testCase.minRoutes,
    `${testCase.dir}: expected at least ${testCase.minRoutes} routes, got ${result.project.operations.length}`,
  );
  console.log(`dist smoke ${testCase.dir}: ${result.project.operations.length} routes`);
}

console.log("dist smoke passed");

// Regression: the Electron integration imports the scanner from an eval'd
// worker thread whose ambient require is anchored at the host cwd. The
// tree-sitter runtime must anchor resolution at its own bundle so WASM
// grammars load from this package's dependencies instead of a hoisted,
// incompatible copy. Reproduce that environment for one WASM language (Java).
await new Promise((resolve, reject) => {
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      try {
        const scanner = await import(workerData.entry);
        const result = await scanner.scanProject({ root: workerData.root, includeTests: true });
        parentPort.postMessage({ count: result.project.operations.length, frameworks: result.report.frameworks });
      } catch (error) {
        parentPort.postMessage({ error: error.message });
      }
    })();
  `;
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { entry: distEntry, root: join(fixtures, "spring-java") },
  });
  const timer = setTimeout(() => {
    worker.terminate();
    reject(new Error("worker thread scan timed out"));
  }, 60000);
  worker.on("message", (message) => {
    clearTimeout(timer);
    if (message.error) {
      reject(new Error(`worker thread scan failed: ${message.error}`));
    } else {
      assert.ok(
        message.frameworks.includes("spring"),
        `worker scan expected spring, got ${message.frameworks}`,
      );
      assert.ok(message.count >= 1, `worker scan expected routes, got ${message.count}`);
      console.log(`dist smoke worker-thread spring-java: ${message.count} routes`);
      resolve();
    }
  });
  worker.on("error", reject);
});

console.log("dist worker-thread smoke passed");
