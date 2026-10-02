import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "spring-enter");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, converted, doc: converted.document as any };
}

describe("spring shard/enter hardening", () => {
  it("resolves the HTTP verb for @RequestMapping with a static-imported bare constant", async () => {
    const { doc } = await scan();
    // `method = POST` via static import must bind to POST, not the GET default.
    expect(doc.paths["/enter/users"].post).toBeDefined();
    expect(doc.paths["/enter/users"].get).toBeUndefined();
    expect(doc.paths["/enter/users/{id}"].delete).toBeDefined();
  });

  it("maps @Email and @Size precisely on the request body DTO", async () => {
    const { doc } = await scan();
    const body = doc.paths["/enter/users"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/AuthParams" });

    const dto = doc.components.schemas.AuthParams;
    expect(dto.properties.email).toEqual({ type: "string", format: "email" });
    expect(dto.properties.password).toEqual({
      type: "string",
      minLength: 8,
      maxLength: 72,
    });
    expect(dto.required.sort()).toEqual(["email", "password"]);
  });

  it("does not expand the @AuthenticationPrincipal security principal into query params", async () => {
    const { doc } = await scan();
    const op = doc.paths["/enter/search"].get;
    const query = op.parameters
      .filter((p: any) => p.in === "query")
      .map((p: any) => p.name)
      .sort();
    // Only the explicit @RequestParam survives; User's id/email/username must not.
    expect(query).toEqual(["q"]);
    const headers = op.parameters
      .filter((p: any) => p.in === "header")
      .map((p: any) => p.name);
    expect(headers).toEqual(["Authorization"]);
  });

  it("ignores the security principal on a path-variable handler", async () => {
    const { doc } = await scan();
    const params = doc.paths["/enter/users/{id}"].delete.parameters;
    const names = params.map((p: any) => `${p.in}:${p.name}`);
    expect(names).toEqual(["path:id"]);
  });
});
