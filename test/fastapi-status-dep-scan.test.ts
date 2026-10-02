import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-status-dep");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("fastapi status constants and attribute-style dependencies", () => {
  it("resolves status.HTTP_204_NO_CONTENT to a bodyless 204 and expands attribute deps", async () => {
    const { result, doc } = await scan();

    const op = result.project.operations.find(
      (o: any) => o.method === "delete" && (o.fullPath ?? o.path) === "/api/items/{item_id}",
    );
    expect(op, "delete operation discovered").toBeDefined();
    expect(op.gaps ?? []).toEqual([]);
    expect(op.confidence).toBe("high");

    const pathParam = (op.parameters as any[]).find((p) => p.name === "item_id");
    expect(pathParam).toMatchObject({ in: "path", required: true });
    // Surfaced from Depends(deps.fetch_item), not the completeness-gate fallback.
    expect(pathParam.schema).toEqual({ type: "integer", minimum: 1 });

    // 204 No Content: a single bodyless response, not a guessed 200 / gap.
    const responses = doc.paths["/api/items/{item_id}"].delete.responses;
    expect(Object.keys(responses)).toEqual(["204"]);
    expect(responses["204"].content ?? {}).toEqual({});
  });
});
