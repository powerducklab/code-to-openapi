import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gorillamux-edge");

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

describe("gorilla/mux pack", () => {
  it("detects method/routed paths, regex vars and PathPrefix subrouters", async () => {
    const { result } = await scan();
    const paths = result.project.operations.map((o: any) => `${o.method} ${o.fullPath ?? o.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        "get /products",
        "post /products",
        "get /products/{id}",
        "get /api/ping",
      ]),
    );
  });

  it("strips {id:[0-9]+} regex to {id} and surfaces Queries/Headers constraints", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/products");
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["query:tag", "header:X-Trace"]),
    );

    const detail = op(ops, "get", "/products/{id}");
    expect(detail.parameters.find((p: any) => p.name === "id" && p.in === "path")).toBeDefined();
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
  });

  it("captures decoded JSON body and Created/BadRequest responses", async () => {
    const { result } = await scan();
    const create = op(result.project.operations, "post", "/products");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/ProductInput",
    });
    expect(create.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "400"]);
  });

  it("reports the listen address", async () => {
    const { result } = await scan();
    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8094" });
  });
});
