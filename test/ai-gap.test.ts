import { describe, expect, it } from "vitest";

import {
  buildGapMessages,
  GAP_PROMPT_VERSION,
  parseGapResolution,
  sanitizeSchema,
} from "../src/ai/prompt.js";
import type { GapRequest } from "../src/ai/gapResolver.js";

const baseRequest: GapRequest = {
  route: { method: "post", path: "/orders" },
  origin: { file: "src/app.js", line: 12 },
  gaps: ["body-schema-unknown", "response-schema-unknown"],
  handlerSource:
    'app.post("/orders", (req, res) => res.status(201).json({ id: req.body.id }));',
  known: { pathParameters: [], framework: "express", language: "typescript" },
};

describe("buildGapMessages", () => {
  it("produces a system/user message pair embedding the handler slice", () => {
    const messages = buildGapMessages(baseRequest);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("handlerSource");
    expect(messages[1]!.content).toContain("/orders");
    expect(messages[0]!.content).toMatch(/never invent/i);
  });

  it("has a stable prompt version tag", () => {
    expect(GAP_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("parseGapResolution", () => {
  it("parses a complete model envelope", () => {
    const resolution = parseGapResolution(
      JSON.stringify({
        bodySchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        responseSchemas: {
          "201": { type: "object", properties: { id: { type: "string" } } },
        },
        confidence: "high",
        rationale: "Body and response are explicit in the handler.",
      }),
    );
    expect(resolution).not.toBeNull();
    expect(resolution!.bodySchema?.properties?.name).toEqual({ type: "string" });
    expect(resolution!.responseSchemas?.["201"]).toBeTruthy();
    expect(resolution!.confidence).toBe("high");
  });

  it("strips markdown fences", () => {
    const resolution = parseGapResolution(
      '```json\n{"queryParameters":[{"name":"q","schema":{"type":"string"}}]}\n```',
    );
    expect(resolution?.querySchema?.properties?.q).toEqual({ type: "string" });
  });

  it("rejects external $ref and oversized junk", () => {
    const resolution = parseGapResolution({
      bodySchema: {
        type: "object",
        properties: {
          evil: { $ref: "https://attacker.example/schema.json" },
          ok: { type: "integer" },
        },
      },
    });
    const body = resolution!.bodySchema!;
    expect(body.properties?.evil).toBeUndefined();
    expect(body.properties?.ok).toEqual({ type: "integer" });
  });

  it("returns null for empty or garbage responses", () => {
    expect(parseGapResolution("nonsense")).toBeNull();
    expect(parseGapResolution("{}")).toBeNull();
    expect(parseGapResolution({ confidence: "low" })).toBeNull();
  });

  it("validates SSE event names and keeps data schemas", () => {
    const resolution = parseGapResolution({
      sseEvents: [
        { name: "tick", dataSchema: { type: "object", properties: { t: { type: "number" } } } },
        { name: "../bad" },
      ],
    });
    expect(resolution?.sseEvents).toHaveLength(1);
    expect(resolution?.sseEvents?.[0]?.name).toBe("tick");
  });

  it("coerces unknown confidence to medium", () => {
    const resolution = parseGapResolution({
      bodySchema: { type: "object", properties: { a: { type: "string" } } },
      confidence: "definitely",
    });
    expect(resolution?.confidence).toBe("medium");
  });
});

describe("sanitizeSchema", () => {
  it("accepts bounded nested schemas", () => {
    const schema = sanitizeSchema({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        required: ["id"],
      },
    });
    expect(schema).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      },
    });
  });

  it("drops malformed property keys and non-schema values", () => {
    const schema = sanitizeSchema({
      type: "object",
      properties: { good: { type: "boolean" }, "bad key!": { type: "string" }, x: "not-a-schema" },
    });
    expect(Object.keys(schema?.properties ?? {})).toEqual(["good"]);
  });
});
