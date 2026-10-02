import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "slim-basic");

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

describe("Slim 4 routing pack", () => {
  it("produces a valid document and claims only slim", async () => {
    const { result, converted } = await scan();
    expect(converted.ok).toBe(true);
    expect(converted.documentValid).toBe(true);
    expect(result.report.frameworks).toEqual(["slim"]);
  });

  it("registers verb routes with {name} path params and query/header extraction", async () => {
    const { result } = await scan();
    const show = op(result.project.operations, "get", "/users/{id}");
    const pathParam = show.parameters.find((p: any) => p.in === "path" && p.name === "id");
    expect(pathParam).toBeDefined();
    expect(show.parameters.find((p: any) => p.in === "query" && p.name === "name")).toBeDefined();
    expect(show.responses[0].statusCode).toBe("200");
    expect(show.responses[0].content[0].mediaType).toBe("application/json");
  });

  it("marks a getParsedBody() request body as an honest dynamic {} with a gap", async () => {
    const { result } = await scan();
    const create = op(result.project.operations, "post", "/users");
    expect(create.requestBody.content[0].mediaType).toBe("application/json");
    expect(create.requestBody.content[0].schema).toEqual({});
    expect(create.gaps).toContain("body-schema-unknown");
    expect(create.responses.some((r: any) => r.statusCode === "201")).toBe(true);
  });

  it("concatenates $app->group prefixes onto inner verb routes", async () => {
    const { result } = await scan();
    const put = op(result.project.operations, "put", "/api/v1/items/{id}");
    expect(put.parameters.find((p: any) => p.in === "path" && p.name === "id")).toBeDefined();
    expect(put.responses[0].statusCode).toBe("200");

    const del = op(result.project.operations, "delete", "/api/v1/items/{id}");
    expect(del.responses.some((r: any) => r.statusCode === "204")).toBe(true);
    expect(del.responses[0].content).toBeUndefined();
  });

  it("documents withHeader(octet-stream) as a binary response", async () => {
    const { result } = await scan();
    const csv = op(result.project.operations, "get", "/report.csv");
    expect(csv.responses[0].content[0].mediaType).toBe("application/octet-stream");
  });
});
