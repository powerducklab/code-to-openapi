import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "spring-cross-service");

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

function component(converted: any, name: string) {
  const schema = converted.document.components?.schemas?.[name];
  expect(schema, `component ${name}`).toBeDefined();
  return schema;
}

describe("spring cross-service return-type following", () => {
  it("follows return service.method() to a concrete DTO across classes", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const detail = op(ops, "get", "/articles/{id}");
    expect(detail.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/ArticleDto",
    });
    expect(detail.confidence).toBe("high");
    expect(detail.gaps).not.toContain("response-unknown");
    expect(detail.gaps).not.toContain("response-schema-unknown");

    const dto = component(converted, "ArticleDto");
    expect(dto.properties.id).toEqual({ type: "integer", format: "int64" });
    expect(dto.properties.title).toEqual({ type: "string" });
  });

  it("follows service calls returning collections and generic envelopes", async () => {
    const { result, converted } = await scan();
    const ops = result.project.operations;

    const list = op(ops, "get", "/articles");
    expect(list.responses[0].content[0].schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/ArticleDto" },
    });
    expect(list.gaps).not.toContain("response-unknown");

    // Interface-typed field: UserService (not the impl).
    const user = op(ops, "get", "/articles/users/{id}");
    expect(user.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/UserVo",
    });

    // Nested generic: PageResult<UserVo> specialized through every layer.
    const page = op(ops, "get", "/articles/users/page");
    expect(page.responses[0].content[0].schema).toEqual({
      $ref: "#/components/schemas/PageResult_UserVo",
    });
    const pageSpec = component(converted, "PageResult_UserVo");
    expect(pageSpec.properties.list).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/UserVo" },
    });
    expect(pageSpec.properties.total).toEqual({ type: "integer", format: "int64" });
  });

  it("keeps honest gaps for dynamic and unresolvable returns", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const dynamic = op(ops, "get", "/articles/dynamic");
    expect(dynamic.gaps).toContain("response-unknown");

    const legacy = op(ops, "get", "/articles/legacy");
    expect(legacy.gaps).toContain("response-unknown");
  });
});
