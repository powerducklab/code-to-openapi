import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "fixtures", "express-commonjs");

function op(ops: any[], method: string, path: string) {
  const found = ops.find(
    (o) => o.method === method && (o.fullPath ?? o.path) === path,
  );
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("express CommonJS router mounting and object-method controllers", () => {
  it("detects require('express'), app.use prefix mounting, and module.exports controllers", async () => {
    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    // Root inline handler.
    op(ops, "get", "/");
    // Mounted sub-router inherits the /users prefix.
    op(ops, "get", "/users");
    op(ops, "post", "/users");
    expect(ops.length).toBeGreaterThanOrEqual(4);
  });
});
