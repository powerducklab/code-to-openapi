import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "aspnet-enter");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, converted, doc: converted.document as any };
}

describe("aspnet shard/enter hardening", () => {
  it("inherits [ApiController]/[Route] from the abstract base controller", async () => {
    const { doc } = await scan();
    // Without base-route inheritance these collapse to "/" / "/{id}".
    expect(doc.paths["/api/Things/GetAll"]).toBeDefined();
    expect(doc.paths["/api/Things/Get/{id}"]).toBeDefined();
    expect(doc.paths["/api/Things/Create"]).toBeDefined();
    expect(doc.paths["/"]).toBeUndefined();
  });

  it("expands the [action] route token to the literal action method name", async () => {
    const { doc } = await scan();
    // Two parameterless GET actions must not collide; [action] is the method name.
    expect(doc.paths["/api/Things/GetAll"].get).toBeDefined();
    expect(doc.paths["/api/Things/Download"].get).toBeDefined();
    expect(
      doc.paths["/api/Things/Get/{id}"].get.parameters.find(
        (p: any) => p.name === "id" && p.in === "path",
      ),
    ).toBeDefined();
  });

  it("produces controller-qualified, collision-free operationIds", async () => {
    const { doc } = await scan();
    expect(doc.paths["/api/Things/GetAll"].get.operationId).toBe("Things_GetAll");
    expect(doc.paths["/api/Things/Create"].post.operationId).toBe("Things_Create");
  });

  it("maps [FromBody] DTOs and FileResult binary responses", async () => {
    const { doc } = await scan();
    const body = doc.paths["/api/Things/Create"].post.requestBody.content["application/json"].schema;
    expect(body).toEqual({ $ref: "#/components/schemas/ThingCommand" });

    const download = doc.paths["/api/Things/Download"].get.responses["200"];
    expect(download.content["application/octet-stream"].schema).toEqual({
      type: "string",
      format: "binary",
    });
  });
});
