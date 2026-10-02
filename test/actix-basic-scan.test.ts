import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "actix-basic");

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

describe("actix-web macro routes", () => {
  it("resolves #[get/post] handlers, extractors and scope prefixes", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    // Scope prefix /api applied to macro handlers.
    const get = op(ops, "get", "/api/users/{id}");
    expect(get.parameters.map((p: any) => p.name)).toEqual(["id"]);
    expect(get.responses[0].statusCode).toBe("200");
    expect(get.responses[0].content[0].schema).toEqual({ $ref: "#/components/schemas/User" });

    const list = op(ops, "get", "/api/users");
    expect(list.parameters.map((p: any) => p.name).sort()).toEqual(["limit", "q"]);

    const create = op(ops, "post", "/api/users");
    expect(create.requestBody.content[0].schema).toEqual({ $ref: "#/components/schemas/UserInput" });
    expect(create.responses[0].statusCode).toBe("201");
  });

  it("emits non-200 status codes and NoContent honestly", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const fail = op(ops, "get", "/api/users/{id}/fail");
    expect(fail.responses[0].statusCode).toBe("400");
    expect(fail.responses[0].content[0].schema).toEqual({ $ref: "#/components/schemas/ErrorBody" });

    const del = op(ops, "delete", "/api/users/{id}");
    expect(del.responses[0].statusCode).toBe("204");
    expect(del.responses[0].content).toBeUndefined();
  });

  it("detects streaming octet-stream and resource().route() chains", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const report = op(ops, "get", "/api/report");
    expect(report.responses[0].content[0].mediaType).toBe("application/octet-stream");

    // web::resource("/articles").route(web::get().to(...)) top-level via configure.
    const articles = op(ops, "get", "/articles");
    expect(articles.responses[0].statusCode).toBe("200");
  });
});
