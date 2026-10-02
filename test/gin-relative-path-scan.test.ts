import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gin-relative-path");

describe("gin relative route paths", () => {
  it("normalizes a leading-slash-less pattern to an absolute, schema-valid path", async () => {
    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert({ validate: true });

    // The document must validate: relative OpenAPI path keys (no leading "/")
    // were the production failure against gin-gonic/examples.
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const paths = result.project.operations.map((o) => o.path);
    expect(paths).toContain("/favicon.ico");
    expect(paths).toContain("/health");
    // No path key may lack a leading slash.
    for (const p of paths) expect(p.startsWith("/")).toBe(true);

    const doc = converted.document as any;
    expect(Object.keys(doc.paths).sort()).toEqual(["/favicon.ico", "/health"]);
  });
});
