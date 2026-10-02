import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("express barrel (`export *`) handler resolution", () => {
  it("resolves handlers re-exported through a barrel and extracts req.body/req.query", async () => {
    const root = join(FIXTURES, "express-barrel");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("express");
    // Handlers must be resolved through `export * from './auth'` / `./users'`.
    expect(result.project.unresolved).toEqual([]);

    const converted = await result.convert({ validate: true });
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    expect(Object.keys(doc.paths).sort()).toEqual(
      ["/api/login", "/api/users"].sort(),
    );

    const login = doc.paths["/api/login"].post;
    // `const { email, password } = req.body` -> body fields discovered.
    const bodyProps = login.requestBody.content["application/json"].schema.properties;
    expect(Object.keys(bodyProps).sort()).toEqual(["email", "password"]);
    expect(login.responses["200"]).toBeDefined();

    const list = doc.paths["/api/users"].get;
    const q = list.parameters.find((p: any) => p.name === "q");
    expect(q.in).toBe("query");
    expect(list.responses["200"]).toBeDefined();
  });
});
