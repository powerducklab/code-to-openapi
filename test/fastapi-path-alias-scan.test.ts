import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-path-alias");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("fastapi Path(alias=...)", () => {
  it("exposes the alias name as the path parameter instead of the python arg name", async () => {
    const { result, converted } = await scan();
    expect(converted.ok, converted.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    expect(converted.documentValid).toBe(true);

    const del = op(result.project.operations, "delete", "/articles/{slug}/comments/{commentId}");
    const pathParams = (del.parameters ?? [])
      .filter((p: any) => p.in === "path")
      .map((p: any) => p.name)
      .sort();

    // The python arg is `comment_id` but Path(alias="commentId") renames it on the wire.
    expect(pathParams).toEqual(["commentId", "slug"]);

    const commentId = (del.parameters ?? []).find((p: any) => p.name === "commentId");
    expect(commentId.in).toBe("path");
    expect(commentId.schema).toEqual({ type: "integer" });

    // The raw python arg name must never leak as a separate path parameter.
    expect((del.parameters ?? []).some((p: any) => p.name === "comment_id")).toBe(false);
  });
});
