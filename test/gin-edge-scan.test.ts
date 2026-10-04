import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "gin-edge");

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

describe("gin edge cases", () => {
  it("resolves nested groups, query structs, cookies, headers and typed bodies", async () => {
    const { result, converted } = await scan();
    expect(converted.documentValid).toBe(true);
    const ops = result.project.operations;

    const list = op(ops, "get", "/v1/articles");
    const queryNames = list.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name);
    expect(queryNames).toEqual(["tag", "limit", "offset"]);
    expect(list.parameters.find((p: any) => p.name === "tag").required).toBe(true);
    expect(list.parameters.find((p: any) => p.name === "limit").schema).toEqual({
      type: "integer",
      format: "int64",
    });
    expect(list.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["header:X-Trace", "cookie:session"]),
    );
    // gin.H values sourced from local variables stay an honest gap.
    expect(list.gaps).toContain("response-schema-unknown");
    expect(list.responses.map((r: any) => r.statusCode)).toContain("400");

    const create = op(ops, "post", "/v1/articles");
    expect(create.requestBody.content[0].schema).toEqual({
      $ref: "#/components/schemas/input_ArticleInput",
    });
    expect(create.responses.map((r: any) => r.statusCode).sort()).toEqual(["201", "422"]);
  });

  it("captures abort responses, bodyless statuses, redirects and binary data", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const detail = op(ops, "get", "/v1/articles/{id}");
    expect(detail.responses.map((r: any) => r.statusCode).sort()).toEqual(["200", "404"]);
    expect(detail.responses.find((r: any) => r.statusCode === "404").content[0].schema).toEqual({
      $ref: "#/components/schemas/ErrorBody",
    });

    const remove = op(ops, "delete", "/v1/articles/{id}");
    expect(remove.responses[0].statusCode).toBe("204");
    expect(remove.responses[0].content).toBeUndefined();

    const redirect = op(ops, "get", "/v1/articles/old/{id}");
    expect(redirect.responses[0].statusCode).toBe("302");
    expect(redirect.responses[0].content).toBeUndefined();

    const report = op(ops, "get", "/v1/reports/{name}");
    expect(report.responses[0].content[0]).toEqual({
      mediaType: "application/pdf",
      schema: { type: "string", format: "binary" },
      confidence: "high",
    });
  });

  it("detects SSE streams, inline handlers and server addresses", async () => {
    const { result } = await scan();
    const ops = result.project.operations;

    const stream = op(ops, "get", "/v1/events");
    expect(stream.extensions?.["x-protocol"]).toBe("sse");
    expect(stream.responses[0].content[0].mediaType).toBe("text/event-stream");
    expect(stream.gaps).toContain("sse-events-unknown");

    const health = op(ops, "get", "/healthz");
    expect(health.responses[0].content[0].schema.properties.ok).toEqual({ type: "boolean" });

    expect(result.project.servers).toContainEqual({ url: "http://127.0.0.1:8091" });
    // The decoy MetricsClient.Get/Post methods never register routes.
    expect(result.project.operations.some((o: any) => (o.fullPath ?? o.path).includes("metrics"))).toBe(
      false,
    );
  });
});
