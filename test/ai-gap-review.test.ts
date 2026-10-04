import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { GapResolver } from "../src/ai/gapResolver.js";
import {
  applyGapDecision,
  buildGapReview,
  proposeGap,
  type GapDecision,
} from "../src/ai/review.js";
import type { RouteCandidate } from "../src/core/types.js";
import { scanProject } from "../src/core/engine.js";

const fixtureRoot = resolve(__dirname, "fixtures/express-js-gaps");

class StubResolver implements GapResolver {
  readonly id = "review-stub";
  async resolve() {
    return {
      bodySchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      responseSchemas: {
        "202": {
          type: "object",
          properties: { received: { type: "boolean" } },
        },
      },
      confidence: "medium",
      rationale: "Handler echoes the accepted body.",
    };
  }
}

describe("manual AI gap review", () => {
  it("surfaces reviews without merging, then applies accepted proposals", { timeout: 20000 }, async () => {
    const result = await scanProject({
      root: fixtureRoot,
      includeTests: true,
      aiReview: "manual",
    });

    // Manual mode never calls a model during scanning and leaves gaps open.
    expect(result.report.aiAttempted).toBe(0);
    expect(result.report.aiPending).toBe(2);
    expect(result.gapReviews).toHaveLength(2);
    expect(result.report.gaps.length).toBeGreaterThan(0);

    const collect = result.gapReviews!.find(
      (review) => review.routeKey === "post /collect",
    )!;
    expect(collect.gaps).toContain("body-schema-unknown");
    expect(collect.request.handlerSource.length).toBeGreaterThan(0);

    const resolver = new StubResolver();
    const proposal = await proposeGap(resolver, collect);
    expect(proposal).not.toBeNull();
    expect(proposal!.resolution.responseSchemas?.["202"]).toBeTruthy();

    const accepted = applyGapDecision(
      result.project.operations,
      collect,
      { action: "accept", resolution: proposal!.resolution } satisfies GapDecision,
    );
    expect(accepted.applied).toBe(true);
    expect(accepted.operation.gaps ?? []).toEqual([]);
    // Every AI-derived schema is visibly tagged.
    expect(
      accepted.operation.responses.find((r) => r.statusCode === "202")?.content?.[0]
        ?.schema?.["x-ai-inferred"],
    ).toBe(true);
    expect(
      accepted.operation.requestBody?.content[0]?.schema?.["x-ai-inferred"],
    ).toBe(true);
    // AI confidence is never promoted above medium.
    expect(accepted.operation.confidence).toBe("medium");
  });

  it("leaves rejected proposals unmerged", { timeout: 20000 }, async () => {
    const result = await scanProject({
      root: fixtureRoot,
      includeTests: true,
      aiReview: "manual",
    });
    const collect = result.gapReviews!.find(
      (review) => review.routeKey === "post /collect",
    )!;
    const proposal = await proposeGap(new StubResolver(), collect);
    const rejected = applyGapDecision(result.project.operations, collect, {
      action: "reject",
      resolution: proposal!.resolution,
    });
    expect(rejected.applied).toBe(false);
    expect(rejected.operation.gaps).toContain("body-schema-unknown");
    expect(
      rejected.operation.requestBody?.content[0]?.schema?.["x-ai-inferred"],
    ).toBeUndefined();
  });

  it("buildGapReview ignores candidates without gaps or handler source", () => {
    const candidate = {
      method: "get",
      path: "/ok",
      origin: { file: "a.js" },
      parameters: [],
      responses: [],
      tags: [],
      confidence: "high",
      gaps: [],
      components: [],
    } as unknown as RouteCandidate;
    expect(buildGapReview(candidate, [])).toBeNull();
  });
});
