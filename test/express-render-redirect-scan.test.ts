import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "fixtures", "express-render-redirect");

describe("express res.render / res.redirect terminal responses", () => {
  it("documents render as 200 text/html and redirect as 302, no response gap", async () => {
    const result = await scanProject({ root, includeTests: true });
    const converted = await result.convert({ validate: true });
    expect(converted.documentValid).toBe(true);

    const byPath = new Map(
      result.project.operations.map((o) => [o.fullPath ?? o.path, o]),
    );

    const page = byPath.get("/page");
    expect(page).toBeTruthy();
    expect(page.responses.some((r: any) => r.statusCode === "200")).toBe(true);
    expect(page.gaps).not.toContain("response-unknown");

    const old = byPath.get("/old");
    expect(old).toBeTruthy();
    expect(old.responses.some((r: any) => /^3\d\d$/.test(r.statusCode))).toBe(true);
    expect(old.gaps).not.toContain("response-unknown");
  });

  it("types template path params as string with no path-param-untyped gap", async () => {
    const result = await scanProject({ root, includeTests: true });
    const op = result.project.operations.find(
      (o) => (o.fullPath ?? o.path) === "/users/{id}",
    );
    expect(op).toBeTruthy();
    expect(op.gaps).not.toContain("path-param-untyped");
    const idParam = op.parameters.find((p: any) => p.in === "path" && p.name === "id");
    expect(idParam?.schema).toEqual({ type: "string" });
  });
});
