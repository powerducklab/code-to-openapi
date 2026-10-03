import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { GapRequest, GapResolver } from "../src/ai/gapResolver.js";
import { scanProject } from "../src/core/engine.js";

const fixtureRoot = resolve(__dirname, "fixtures/express-js-gaps");

/**
 * Stub resolver: returns canned fragments per route, mimicking a host that
 * validated the model JSON through parseGapResolution first.
 */
class StubGapResolver implements GapResolver {
  readonly id = "test-stub";
  readonly calls: GapRequest[] = [];

  async resolve(request: GapRequest) {
    this.calls.push(request);
    if (request.route.method === "post" && request.route.path === "/collect") {
      return {
        bodySchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
          },
          required: ["name"],
        },
        querySchema: {
          type: "object",
          properties: { dryRun: { type: "boolean" } },
        },
        responseSchemas: {
          "202": {
            type: "object",
            properties: {
              received: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
        confidence: "high",
      };
    }
    if (request.route.method === "get" && request.route.path === "/stream") {
      return {
        sseEvents: [
          {
            name: "ping",
            dataSchema: {
              type: "object",
              properties: { at: { type: "number" } },
              required: ["at"],
            },
          },
        ],
        confidence: "medium",
      };
    }
    return null;
  }
}

describe("scanProject AI gap resolver", () => {
  it(
    "fills body, query, response and SSE gaps without inventing routes",
    { timeout: 20000 },
    async () => {
    const withoutAi = await scanProject({ root: fixtureRoot, includeTests: true });
    expect(withoutAi.report.routesConfirmed).toBe(0);
    expect(withoutAi.report.routesPartial).toBe(2);

    const resolver = new StubGapResolver();
    const withAi = await scanProject({
      root: fixtureRoot,
      includeTests: true,
      gapResolver: resolver,
    });

    // Same two routes; the resolver never creates routes.
    const paths = Object.keys(withAi.project.operations.reduce<Record<string, true>>((acc, op) => {
      acc[`${op.method} ${op.path}`] = true;
      return acc;
    }, {}));
    expect(paths.sort()).toEqual(["get /stream", "post /collect"]);

    const collect = withAi.project.operations.find(
      (op) => op.method === "post" && op.path === "/collect",
    )!;
    expect(collect.gaps ?? []).toEqual([]);
    expect(collect.confidence).toBe("medium");
    expect(collect.requestBody?.content[0]?.schema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" }, price: { type: "number" } },
    });
    // The fixture never reads query parameters: ignore this unsolicited AI field.
    expect(collect.parameters.some((p) => p.in === "query" && p.name === "dryRun")).toBe(false);
    const accepted = collect.responses.find((r) => r.statusCode === "202");
    expect(accepted?.content?.[0]?.schema).toMatchObject({
      type: "object",
      properties: { received: { type: "object" } },
    });

    const stream = withAi.project.operations.find(
      (op) => op.method === "get" && op.path === "/stream",
    )!;
    expect(stream.gaps ?? []).toEqual([]);
    const itemSchema = stream.responses[0]?.content?.find(
      (media) => media.mediaType === "text/event-stream",
    )?.itemSchema;
    expect(itemSchema).toMatchObject({
      type: "object",
      properties: { at: { type: "number" } },
      required: ["at"],
    });

    // Resolver only ran for routes with gaps, with small handler slices.
    expect(resolver.calls).toHaveLength(2);
    for (const call of resolver.calls) {
      expect(call.handlerSource.length).toBeLessThan(8000);
      expect(call.gaps.length).toBeGreaterThan(0);
    }

    const converted = await withAi.convert();
    expect(converted.ok).toBe(true);
  });

  it("keeps deterministic output when no resolver is provided", async () => {
    const result = await scanProject({ root: fixtureRoot, includeTests: true });
    const collect = result.project.operations.find(
      (op) => op.method === "post" && op.path === "/collect",
    )!;
    expect(collect.gaps).toContain("body-schema-unknown");
  });
});

it('retains discovered routes and gaps when the model fails',async()=>{
 const result=await scanProject({root:fixtureRoot,gapResolver:{id:'failure',resolve:async()=>{throw new Error('offline');}}});
 expect(result.project.operations).toHaveLength(2);
 expect(result.project.operations.some(o=>o.gaps?.length)).toBe(true);
 expect(result.report.diagnostics.some(d=>d.includes('offline'))).toBe(true);
});
