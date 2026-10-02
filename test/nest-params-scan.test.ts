import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("nest @Param / @Query static param inference", () => {
  it("types an untyped @Param('slug') as string without path-param-untyped, and expands a @Query() DTO", async () => {
    const root = join(FIXTURES, "nest-params");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("nest");

    const converted = await result.convert({ validate: true });
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;

    // GET /articles/:slug — untyped @Param('slug') closes the gap with {type:string}.
    const getOne = doc.paths["/articles/{slug}"].get;
    const slugParam = getOne.parameters.find((p: any) => p.name === "slug");
    expect(slugParam.in).toBe("path");
    expect(slugParam.required).toBe(true);
    expect(slugParam.schema).toEqual({ type: "string" });
    const slugOp = result.project.operations.find(
      (o) => o.method === "get" && (o.fullPath ?? o.path) === "/articles/{slug}",
    );
    expect(slugOp?.gaps ?? []).not.toContain("path-param-untyped");

    // GET /articles — @Query() ListArticlesQueryDto expands into query params.
    const getAll = doc.paths["/articles"].get;
    const queryNames = getAll.parameters
      .filter((p: any) => p.in === "query")
      .map((p: any) => p.name)
      .sort();
    expect(queryNames).toEqual(["limit", "offset", "tag"].sort());
    const limit = getAll.parameters.find((p: any) => p.name === "limit");
    expect(limit.schema).toEqual({ type: "number" });
    expect(limit.required).toBe(true);
    const tag = getAll.parameters.find((p: any) => p.name === "tag");
    expect(tag.required ?? false).toBe(false);
    const listOp = result.project.operations.find(
      (o) => o.method === "get" && (o.fullPath ?? o.path) === "/articles",
    );
    expect(listOp?.gaps ?? []).not.toContain("query-unknown");
  });
});
