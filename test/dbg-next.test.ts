import { it } from "vitest";
import { createTsAnalysis } from "../src/lang/typescript/index.js";
import { indexProject } from "../src/core/indexer.js";
import { probeManifest } from "../src/core/probe.js";
import { nextjsPack } from "../src/frameworks/nextjs.js";
it("dbg", async () => {
  const root = process.cwd() + "/test/fixtures/nextjs-edge";
  const idx = indexProject(root, { includeTests: true });
  const ctx: any = { root, index: idx, manifest: probeManifest(root, idx), report: () => {} };
  const analysis = createTsAnalysis(ctx);
  const r = nextjsPack.extract(analysis, ctx as any);
  for (const o of r.routes) if (o.path.includes("legacy")) {
    console.log(JSON.stringify(o.responses, null, 1));
  }
});
