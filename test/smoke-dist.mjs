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
import { scanProject } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

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
