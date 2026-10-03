import { scanProject } from "../src/core/engine.js";

const root = process.argv[2]!;
const result = await scanProject({ root });
const converted = await result.convert();
console.log("ok:", converted.ok, "valid:", converted.documentValid);
if (!converted.ok) {
  for (const d of converted.diagnostics.slice(0, 15)) console.log(JSON.stringify(d));
}
const doc = converted.document as any;
const paths = Object.keys(doc.paths ?? {});
console.log("paths:", paths.length);
let withBody = 0;
let withResp = 0;
let emptyResp = [];
for (const [p, ops] of Object.entries(doc.paths ?? {})) {
  for (const [m, op] of Object.entries(ops as Record<string, any>)) {
    if (["get","post","put","patch","delete","options","head"].includes(m)) {
      if (op.requestBody) withBody++;
      const statuses = Object.keys(op.responses ?? {});
      if (statuses.length) withResp++; else emptyResp.push(`${m} ${p}`);
    }
  }
}
console.log("ops with requestBody:", withBody, "with responses:", withResp);
if (emptyResp.length) console.log("no responses:", emptyResp);
console.log("components:", Object.keys(doc.components?.schemas ?? {}).length);
console.log("unresolved:", result.project.unresolved.length);
const reasons: Record<string, number> = {};
for (const u of result.project.unresolved) reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
console.log(reasons);
