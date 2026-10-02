import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { scanProject } from "../src/index.js";

const root = join(__dirname, "fixtures", "laravel-downloads");

async function scan() {
  const result = await scanProject({ root, includeTests: true });
  const converted = await result.convert({ validate: true });
  return { result, converted };
}

function op(ops: any[], method: string, path: string) {
  const found = ops.find((o) => o.method === method && (o.fullPath ?? o.path) === path);
  expect(found, `${method} ${path}`).toBeDefined();
  return found;
}

function bin200(operation: any) {
  const response = operation.responses.find((r: any) => r.statusCode === "200");
  expect(response, `200 response for ${operation.operationId ?? ""}`).toBeDefined();
  return response?.content?.find((m: any) => m.mediaType === "application/octet-stream");
}

describe("laravel download / stream / facade chains", () => {
  it("documents response()->download() as octet-stream binary with a filename header", async () => {
    const { result } = await scan();
    const o = op(result.project.operations, "get", "/api/helper-download");
    expect(o.gaps).not.toContain("response-unknown");
    const media = bin200(o);
    expect(media?.schema).toEqual({ type: "string", format: "binary" });
    const response = o.responses.find((r: any) => r.statusCode === "200");
    expect(response.headers).toHaveProperty("Content-Disposition");
  });

  it("documents Response::make / Response::download / Response::streamDownload facades", async () => {
    const { result } = await scan();
    for (const path of ["/api/facade-make", "/api/facade-download", "/api/facade-stream"]) {
      const o = op(result.project.operations, "get", path);
      expect(o.gaps, path).not.toContain("response-unknown");
      expect(bin200(o)?.schema, path).toEqual({ type: "string", format: "binary" });
    }
  });

  it("documents response()->streamDownload(), ->file() and ->make()", async () => {
    const { result } = await scan();
    for (const path of ["/api/helper-stream", "/api/file", "/api/make"]) {
      const o = op(result.project.operations, "get", path);
      expect(o.gaps, path).not.toContain("response-unknown");
      expect(bin200(o)?.schema, path).toEqual({ type: "string", format: "binary" });
    }
  });

  it("documents new BinaryFileResponse and assigned-then-returned StreamedResponse", async () => {
    const { result } = await scan();
    for (const path of ["/api/binary-file", "/api/streamed"]) {
      const o = op(result.project.operations, "get", path);
      expect(o.gaps, path).not.toContain("response-unknown");
      expect(bin200(o)?.schema, path).toEqual({ type: "string", format: "binary" });
    }
  });

  it("resolves $this->respondXxx() helpers declared on the base controller", async () => {
    const { result } = await scan();
    const o = op(result.project.operations, "get", "/api/via-base-helper");
    expect(o.gaps).not.toContain("response-unknown");
    expect(bin200(o)?.schema).toEqual({ type: "string", format: "binary" });
    const response = o.responses.find((r: any) => r.statusCode === "200");
    expect(response.headers).toHaveProperty("Content-Disposition");
  });

  it("produces a valid OAS document", async () => {
    const { converted } = await scan();
    expect(converted.documentValid).toBe(true);
  });
});
