import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("monorepo leaf detection (root-miss fallback)", () => {
  it("does not throw on an unsupported-workspace monorepo; yields a valid empty document", async () => {
    const root = join(FIXTURES, "monorepo-waline-like");
    expect(existsSync(root)).toBe(true);

    // Must NOT throw "No supported HTTP framework detected".
    const result = await scanProject({ root, includeTests: false });
    expect(result.project.operations).toEqual([]);

    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);
    expect(Object.keys(converted.document.paths ?? {})).toEqual([]);
  });

  it("leaves a root-resolved monorepo byte-identical (express leaf detected at root)", async () => {
    const root = join(FIXTURES, "monorepo-leaf");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("express");
    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);

    const paths = Object.keys(converted.document.paths ?? {}).sort();
    expect(paths).toEqual(["/hello", "/items"].sort());
    expect(result.project.operations.length).toBe(2);
  });
});
