import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "elysia-arktype");

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

describe("elysia arktype contracts", () => {
  it("converts domains, bounds, arrays and Record shorthands", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/users");
    const listSchema = list.responses[0].content[0].schema;
    expect(listSchema.properties.users.type).toBe("array");
    expect(listSchema.properties.users.items.properties.email.format).toBe("email");
    expect(listSchema.properties.users.items.properties.bio.anyOf).toBeDefined();

    const byId = op(ops, "get", "/users/{id}");
    const idParam = byId.parameters.find((p: any) => p.in === "path" && p.name === "id");
    expect(idParam.schema.format).toBe("uuid");
    const notFound = byId.responses.find((r: any) => r.statusCode === "404");
    const errors = notFound.content[0].schema.properties.errors;
    expect(errors.type).toBe("object");
    expect(errors.additionalProperties.type).toBe("array");

    const create = op(ops, "post", "/users");
    const user = create.requestBody.content[0].schema.properties.user;
    expect(user.properties.username.minLength).toBe(3);
    expect(user.properties.password.minLength).toBe(8);
    expect(user.properties.password.maxLength).toBe(100);
    expect(user.required).not.toContain("website");
    expect(create.responses.some((r: any) => r.statusCode === "201")).toBe(true);
  });
});
