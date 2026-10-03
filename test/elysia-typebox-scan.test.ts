import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "elysia-typebox");

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

describe("elysia native TypeBox (t.*) contracts", () => {
  it("extracts path/query params, bare and status-mapped responses", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const byId = op(ops, "get", "/users/{id}");
    const idParam = byId.parameters.find((p: any) => p.in === "path" && p.name === "id");
    expect(idParam).toBeDefined();
    expect(idParam.required).toBe(true);
    expect(idParam.schema.format).toBe("uuid");
    const include = byId.parameters.find((p: any) => p.in === "query" && p.name === "include");
    expect(include).toBeDefined();
    expect(include.required).toBe(false);
    const page = byId.parameters.find((p: any) => p.in === "query" && p.name === "page");
    expect(page.schema.type).toBe("integer");

    const ok = byId.responses.find((r: any) => r.statusCode === "200");
    expect(ok.content[0].schema.properties.email.format).toBe("email");
    expect(ok.content[0].schema.properties.tags.items.type).toBe("string");
    // t.Nullable -> type array including null (valid OAS 3.2); t.Optional removes required.
    expect(ok.content[0].schema.required).not.toContain("age");
    expect(ok.content[0].schema.properties.nickname.type).toContain("null");
    const notFound = byId.responses.find((r: any) => r.statusCode === "404");
    expect(notFound.content[0].schema.properties.error.type).toBe("string");
  });

  it("extracts request bodies including nested optional objects", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const create = op(ops, "post", "/users");
    const body = create.requestBody.content[0].schema;
    expect(body.properties.email.format).toBe("email");
    expect(body.required).not.toContain("profile");
    expect(body.properties.profile.properties.bio.type).toBe("string");
    // Bare response schema defaults to 200.
    const ok = create.responses.find((r: any) => r.statusCode === "200");
    expect(ok.content[0].schema.properties.id.format).toBe("uuid");
  });

  it("resolves group prefixes and status() helper responses", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const list = op(ops, "get", "/articles");
    const listSchema = list.responses[0].content[0].schema;
    expect(listSchema.properties.articles.type).toBe("array");
    expect(listSchema.properties.articles.items.properties.email.format).toBe("email");

    const createArticle = op(ops, "post", "/articles");
    expect(createArticle.requestBody.content[0].schema.properties.title.minLength).toBe(1);
    expect(createArticle.responses.some((r: any) => r.statusCode === "201")).toBe(true);
  });
});
