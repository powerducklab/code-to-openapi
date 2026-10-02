import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scanProject } from "../src/core/engine.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = join(here, "fixtures");

describe("nest @Body('key') request-body envelope", () => {
  it("wraps a keyed @Body('user') in { user: dto }, and leaves bare @Body() unwrapped", async () => {
    const root = join(FIXTURES, "nest-body-wrap");
    expect(existsSync(root)).toBe(true);

    const result = await scanProject({ root, includeTests: true });
    expect(result.report.frameworks).toContain("nest");

    const converted = await result.convert({ validate: true });
    expect(converted.ok, JSON.stringify(converted.diagnostics, null, 2)).toBe(true);
    expect(converted.documentValid).toBe(true);

    const doc = converted.document as any;
    expect(Object.keys(doc.paths).sort()).toEqual(["/users", "/users/{id}"].sort());

    // @Body('user') CreateUserDto -> { user: CreateUserDto } envelope.
    const create = doc.paths["/users"].post;
    expect(create.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { user: { $ref: "#/components/schemas/CreateUserDto" } },
      required: ["user"],
    });

    // Bare @Body() UpdateUserDto -> the DTO itself is the body root.
    const update = doc.paths["/users/{id}"].put;
    expect(update.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/UpdateUserDto",
    });

    const idParam = update.parameters.find((p: any) => p.name === "id");
    expect(idParam.in).toBe("path");
    expect(idParam.required).toBe(true);
  });
});
