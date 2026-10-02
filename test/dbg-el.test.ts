import { it } from "vitest";
import { createTsAnalysis } from "../src/lang/typescript/index.js";
import { indexProject } from "../src/core/indexer.js";
import { probeManifest } from "../src/core/probe.js";
import { elysiaPack } from "../src/frameworks/elysia.js";
it("dbg", async () => {
  const root = process.cwd() + "/test/fixtures/elysia-edge";
  const idx = indexProject(root, { includeTests: true });
  const ctx: any = { root, index: idx, manifest: probeManifest(root, idx), report: () => {} };
  const analysis = createTsAnalysis(ctx);
  const r = elysiaPack.extract(analysis, ctx as any);
  for (const o of r.routes) if (o.fullPath === "/api/users" && o.method === "get") {
    console.log("RESP", JSON.stringify(o.responses, null, 1));
  }
});
