import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "rocket-basic");

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

describe("Rocket routes", () => {
  it("parses <param> and <param:guard> segments into path params", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const hello = op(ops, "get", "/hello/{name}/{age}");
    const names = hello.parameters.map((p: any) => `${p.in}:${p.name}`);
    expect(names).toContain("path:name");
    expect(names).toContain("path:age");
    const age = hello.parameters.find((p: any) => p.name === "age");
    expect(age.schema).toEqual({ type: "integer", format: "int64" });
    expect(hello.responses[0].content[0].mediaType).toBe("text/plain");
  });

  it("binds Json bodies via data= and Json<T> responses, skips guards", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const create = op(ops, "post", "/api/users");
    expect(create.requestBody.content[0].schema).toEqual({ $ref: "#/components/schemas/NewUser" });
    expect(create.responses[0].statusCode).toBe("200");
    expect(create.responses[0].content[0].schema).toEqual({ $ref: "#/components/schemas/User" });

    // BasicAuth guard must not leak as a parameter.
    const protected_ = op(ops, "get", "/protected");
    expect(protected_.parameters.map((p: any) => p.name)).not.toContain("_auth");
  });

  it("emits status responders (Accepted=202) and mount prefixes", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const accepted = op(ops, "get", "/accepted");
    expect(accepted.responses[0].statusCode).toBe("202");

    const user = op(ops, "get", "/users/{id}");
    expect(user.parameters.find((p: any) => p.name === "id").schema).toEqual({
      type: "integer",
      format: "int64",
    });
  });
});
