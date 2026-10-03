import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "hono-zod-openapi");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find(
    (o) => o.method === method && (o.fullPath ?? o.path) === path,
  );
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

describe("hono @hono/zod-openapi createRoute contracts", () => {
  it("extracts cross-file zod request bodies and computed-status responses", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const login = op(ops, "post", "/api/login");
    const loginBody = login.requestBody.content[0].schema;
    expect(loginBody.type).toBe("object");
    expect(loginBody.properties.user.properties.email.format).toBe("email");
    expect(loginBody.properties.user.properties.password.type).toBe("string");
    expect(loginBody.required).toContain("user");

    const ok = login.responses.find((r: any) => r.statusCode === "200");
    expect(ok).toBeDefined();
    expect(ok.content[0].mediaType).toBe("application/json");
    const unprocessable = login.responses.find((r: any) => r.statusCode === "422");
    expect(unprocessable).toBeDefined();
    expect(unprocessable.content[0].schema.properties).toHaveProperty("errors");
  });

  it("resolves merge/shape/partial chains for register and update", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const register = op(ops, "post", "/api/users");
    const registerUser = register.requestBody.content[0].schema.properties.user;
    expect(registerUser.properties.email.format).toBe("email");
    expect(registerUser.properties.password.minLength).toBe(8);
    expect(registerUser.required).toContain("password");
    expect(register.responses.some((r: any) => r.statusCode === "201")).toBe(true);

    const update = op(ops, "put", "/api/user");
    const updateUser = update.requestBody.content[0].schema.properties.user;
    // .partial() drops the required list while preserving every property.
    expect(updateUser.required).toBeUndefined();
    expect(Object.keys(updateUser.properties).sort()).toEqual([
      "bio",
      "email",
      "image",
      "password",
      "username",
    ]);
  });

  it("extracts zod path params and query params", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const byId = op(ops, "get", "/api/users/{id}");
    const idParam = byId.parameters.find((p: any) => p.in === "path" && p.name === "id");
    expect(idParam).toBeDefined();
    expect(idParam.required).toBe(true);
    expect(idParam.schema.format).toBe("uuid");

    const list = op(ops, "get", "/api/users");
    const q = list.parameters.find((p: any) => p.in === "query" && p.name === "q");
    expect(q).toBeDefined();
    expect(q.required).toBe(false);
    const page = list.parameters.find((p: any) => p.in === "query" && p.name === "page");
    expect(page).toBeDefined();
  });
});
