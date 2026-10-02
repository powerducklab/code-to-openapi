import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "express-listen-noarg");

describe("express pack robustness", () => {
  it("does not crash on app.listen() with no arguments", async () => {
    // Previously threw: Cannot read properties of undefined (reading 'kind')
    // inside ts.isNumericLiteral(undefined) when classifying the listen call.
    const result = await scanProject({ root, includeTests: true });

    const paths = result.project.operations.map((o) => `${o.method} ${o.path}`);
    expect(paths).toContain("get /");

    const converted = await result.convert({ validate: true });
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);
  });
});
