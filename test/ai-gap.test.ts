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
    expect(GAP_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}[a-z]?$/);
  });

  it("embeds the component catalog in the user payload", () => {
    const messages = buildGapMessages({
      ...baseRequest,
      componentCatalog: [{ name: "Order", properties: ["id", "status"] }],
    });
    expect(messages[1]!.content).toContain("existingComponents");
    expect(messages[1]!.content).toContain("Order");
    expect(messages[0]!.content).toMatch(/EXACT listed name/i);
  });

  it("tailors the system prompt to the detected framework", () => {
    const fastify = buildGapMessages({
      ...baseRequest,
      known: { pathParameters: [], framework: "fastify", language: "typescript" },
    });
    expect(fastify[0]!.content).toMatch(/Fastify/);
    expect(fastify[0]!.content).toMatch(/reply\.code/);

    const gin = buildGapMessages({
      ...baseRequest,
      known: { pathParameters: [], framework: "gin", language: "go" },
    });
    expect(gin[0]!.content).toMatch(/Gin/);
    expect(gin[0]!.content).toMatch(/ShouldBindJSON/);

    const unknown = buildGapMessages({
      ...baseRequest,
      known: { pathParameters: [], framework: "weird", language: "python" },
    });
    expect(unknown[0]!.content).toMatch(/Python/);
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

  it("accepts $ref only for whitelisted component names", () => {
    const raw = {
      responseSchemas: {
        "200": {
          type: "object",
          properties: {
            members: {
              type: "array",
              items: { $ref: "#/components/schemas/OrganizationMembership" },
            },
            fabricated: { $ref: "#/components/schemas/DoesNotExist" },
          },
        },
      },
    };
    const allowed = new Set(["OrganizationMembership"]);
    const resolution = parseGapResolution(raw, allowed);
    const schema = resolution?.responseSchemas?.["200"] as any;
    expect(schema.properties.members.items).toEqual({
      $ref: "#/components/schemas/OrganizationMembership",
    });
    // The fabricated reference has no remaining structural signal and is dropped.
    expect(schema.properties.fabricated).toBeUndefined();
  });

  it("rejects every $ref when no catalog is provided", () => {
    const resolution = parseGapResolution({
      bodySchema: { $ref: "#/components/schemas/Account" },
    });
    expect(resolution).toBeNull();
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
