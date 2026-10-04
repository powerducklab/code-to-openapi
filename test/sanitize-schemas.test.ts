import { describe, expect, it } from "vitest";

import { stripPrototypeHazards } from "../src/core/sanitizeSchemas.js";

describe("stripPrototypeHazards", () => {
  it("removes class constructor inference from properties and required", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
        constructor: {
          type: "object",
          properties: { name: { type: "string", const: "RowDataPacket" } },
          required: ["name"],
        },
      },
      required: ["id", "constructor"],
    };
    const result = stripPrototypeHazards(structuredClone(schema));
    expect(Object.keys(result.properties)).toEqual(["id"]);
    expect(result.required).toEqual(["id"]);
  });

  it("cleans nested component schemas recursively", () => {
    const schema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: { __proto__: { type: "object" }, ok: { type: "boolean" } },
            required: ["__proto__", "ok"],
          },
        },
      },
    };
    const result = stripPrototypeHazards(structuredClone(schema));
    const items = result.properties.rows.items;
    expect(Object.keys(items.properties)).toEqual(["ok"]);
    expect(items.required).toEqual(["ok"]);
  });

  it("leaves ordinary enum values untouched", () => {
    const schema = {
      type: "object",
      properties: {
        state: { type: "string", enum: ["constructor", "Ready"] },
      },
    };
    const result = stripPrototypeHazards(structuredClone(schema));
    expect(result.properties.state.enum).toEqual(["constructor", "Ready"]);
  });
});
