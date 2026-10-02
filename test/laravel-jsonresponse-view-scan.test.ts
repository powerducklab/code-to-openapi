import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-jsonresponse-view");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  return result.project.operations;
}

describe("laravel new JsonResponse / view()->with() / redirect()->route()", () => {
  it("documents chained view() as 200 text/html with no response gap", async () => {
    const ops = await scan();
    const show = ops.find((o) => o.method === "get" && o.path === "/page/show");
    expect(show?.gaps ?? []).not.toContain("response-unknown");
    const html = show?.responses.find((r) => r.statusCode === "200");
    expect(html?.content?.[0]?.mediaType).toBe("text/html");
  });

  it("documents inline-array view() as text/html", async () => {
    const ops = await scan();
    const landing = ops.find((o) => o.method === "get" && o.path === "/page/landing");
    expect(landing?.gaps ?? []).not.toContain("response-unknown");
    expect(landing?.responses.find((r) => r.statusCode === "200")?.content?.[0]?.mediaType).toBe(
      "text/html",
    );
  });

  it("documents redirect()->route() chain as 302 with no JSON gap", async () => {
    const ops = await scan();
    const home = ops.find((o) => o.method === "get" && o.path === "/page/home");
    expect(home?.gaps ?? []).not.toContain("response-schema-unknown");
    expect(home?.responses.some((r) => r.statusCode === "302")).toBe(true);
  });

  it("documents new JsonResponse([...]) as a typed JSON 200", async () => {
    const ops = await scan();
    const show = ops.find((o) => o.method === "get" && o.path === "/data/show");
    expect(show?.gaps ?? []).not.toContain("response-schema-unknown");
    const body = show?.responses.find((r) => r.statusCode === "200")?.content?.[0];
    expect(body?.mediaType).toBe("application/json");
    expect(body?.schema?.properties?.message).toEqual({ type: "string" });
    expect(body?.schema?.properties?.count).toEqual({ type: "integer" });
  });

  it("honors the explicit status code on new JsonResponse", async () => {
    const ops = await scan();
    const err = ops.find((o) => o.method === "get" && o.path === "/data/error");
    expect(err?.responses.some((r) => r.statusCode === "400")).toBe(true);
  });

  it("resolves assigned-then-returned new JsonResponse", async () => {
    const ops = await scan();
    const assigned = ops.find((o) => o.method === "get" && o.path === "/data/assigned");
    expect(assigned?.gaps ?? []).not.toContain("response-schema-unknown");
    const body = assigned?.responses.find((r) => r.statusCode === "200")?.content?.[0];
    expect(body?.schema?.properties?.status).toEqual({ type: "string" });
  });
});
