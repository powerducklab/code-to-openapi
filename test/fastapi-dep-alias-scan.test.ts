import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "fastapi-dep-alias");

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

describe("fastapi Annotated dependency aliases", () => {
  it("resolves Annotated[..., Depends] aliases instead of leaking them as query params", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);

    const list = op(result.project.operations, "get", "/items");
    const paramNames = (list.parameters ?? []).map((p: any) => p.name);

    // Only the explicit Query param surfaces; the Depends aliases are not HTTP params.
    expect(paramNames).toEqual(["q"]);
    expect((list.parameters ?? []).find((p: any) => p.name === "q")?.in).toBe("query");
    expect(paramNames).not.toContain("session");
    expect(paramNames).not.toContain("current_user");
    // The transitive dependency chain (get_current_user -> get_token(request: Request))
    // must not leak the Starlette Request object as a query parameter either.
    expect(paramNames).not.toContain("token");
    expect(paramNames).not.toContain("request");
  });
});
