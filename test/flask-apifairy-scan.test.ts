import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "flask-apifairy");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert();
  expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
  expect(converted.documentValid).toBe(true);
  return { result, doc: converted.document as any };
}

describe("flask app-factory blueprints and APIFairy/marshmallow models", () => {
  it("discovers blueprints registered from function-level imports", async () => {
    const { result } = await scan();
    const paths = result.project.operations.map((o: any) => o.fullPath ?? o.path);
    expect(paths).toContain("/api/users/{id}");
  });

  it("extracts @response / @body / @other_responses into explicit schemas", async () => {
    const { result, doc } = await scan();

    const get = result.project.operations.find(
      (o: any) => o.method === "get" && (o.fullPath ?? o.path) === "/api/users/{id}",
    );
    expect(get).toBeDefined();
    const getResp = doc.paths["/api/users/{id}"].get.responses["200"];
    expect(getResp.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/UserSchema",
    });

    const put = result.project.operations.find(
      (o: any) => o.method === "put" && (o.fullPath ?? o.path) === "/api/users/{id}",
    );
    expect(put).toBeDefined();
    expect(put.requestBody?.content[0].mediaType).toBe("application/json");
    expect(put.requestBody?.content[0].schema).toEqual({
      $ref: "#/components/schemas/UpdateUserSchema",
    });
    const putResponses = doc.paths["/api/users/{id}"].put.responses;
    expect(Object.keys(putResponses).sort()).toEqual(["200", "404"]);
    expect(putResponses["404"].description).toBe("User not found");
  });

  it("builds marshmallow components with inherited fields and required flags", async () => {
    const { doc } = await scan();
    const schemas = doc.components.schemas;

    const user = schemas.UserSchema;
    expect(user.properties.id).toEqual({ type: "integer" });
    expect(user.properties.username).toEqual({ type: "string" });
    expect(user.required).toEqual(["username"]);

    const update = schemas.UpdateUserSchema;
    // Inherited field plus the subclass field.
    expect(update.properties.username).toEqual({ type: "string" });
    expect(update.properties.old_password).toEqual({ type: "string" });
    expect(update.required.sort()).toEqual(["old_password", "username"]);
  });
});
