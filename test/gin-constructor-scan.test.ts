import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gin-constructor");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("gin c.JSON constructor-return following", () => {
  it("resolves c.JSON(200, NewUserResponse(...)) to the constructor's struct schema", async () => {
    const { result } = await scan();
    const getUser = op(result.project.operations, "get", "/users/{id}");
    expect(getUser.gaps).not.toContain("response-schema-unknown");
    const media = getUser.responses.find((r: any) => r.statusCode === "200")
      ?.content?.find((c: any) => c.mediaType === "application/json");
    expect(media?.schema).toEqual({ $ref: "#/components/schemas/UserResponse" });
  });

  it("resolves c.JSON(200, NewUsersResponse(...)) to the wrapper struct schema", async () => {
    const { result } = await scan();
    const list = op(result.project.operations, "get", "/users");
    expect(list.gaps).not.toContain("response-schema-unknown");
    const media = list.responses.find((r: any) => r.statusCode === "200")
      ?.content?.find((c: any) => c.mediaType === "application/json");
    expect(media?.schema).toEqual({ $ref: "#/components/schemas/UsersResponse" });
  });

  it("keeps the c.JSON status code and resolves a 201 created payload", async () => {
    const { result } = await scan();
    const create = op(result.project.operations, "post", "/users");
    const resp = create.responses.find((r: any) => r.statusCode === "201");
    expect(resp).toBeDefined();
    expect(resp.content?.[0].schema).toEqual({ $ref: "#/components/schemas/UserResponse" });
  });
});
