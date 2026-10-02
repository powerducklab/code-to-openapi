import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("fastify root-path and namespaced/barrel handlers", () => {
  it("emits root route as '/' (not empty), and resolves controllers.<fn> through namespace + barrel", async () => {
    const root = join(FIXTURES, "fastify-rootpath");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("fastify");
    expect(result.project.unresolved).toEqual([]);

    const converted = await result.convert();
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    const paths = Object.keys(doc.paths).sort();
    // The root route must be the absolute path "/", never an empty key.
    expect(paths).toEqual(["/", "/health", "/users", "/users/{id}"].sort());

    const rootOp = doc.paths["/"].get;
    expect(rootOp.responses["200"]).toBeDefined();
    expect(
      rootOp.responses["200"].content["application/json"].schema.properties.service,
    ).toEqual({ type: "string" });

    // Namespaced handler `controllers.create` resolved through
    // `import * as controllers` + `export * from './user-controller'`.
    const create = doc.paths["/users"].post;
    expect(create).toBeDefined();
    expect(create.requestBody.content["application/json"].schema.required).toEqual(["email"]);
    expect(create.responses["201"]).toBeDefined();
    expect(
      create.responses["201"].content["application/json"].schema,
    ).toEqual({ $ref: "#/components/schemas/UserView" });

    const getOne = doc.paths["/users/{id}"].get;
    const idParam = getOne.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
    expect(idParam.schema).toEqual({ type: "string" });
  });
});
