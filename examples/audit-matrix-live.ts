import { readFileSync, existsSync } from "node:fs";
import { scanProject } from "../src/core/engine.js";

const projects = JSON.parse(
  readFileSync(new URL("../docs/audits/github-projects.json", import.meta.url), "utf8"),
) as Array<{ framework: string; localRoot: string }>;

const rows: Array<Record<string, unknown>> = [];
for (const project of projects) {
  if (!existsSync(project.localRoot)) {
    rows.push({ framework: project.framework, missing: true });
    continue;
  }
  try {
    const result = await scanProject({ root: project.localRoot });
    const converted = await result.convert();
    const doc = converted.document as any;
    let ops = 0;
    let bodies = 0;
    let opsWithParams = 0;
    let opsWithResp = 0;
    for (const ops2 of Object.values(doc.paths ?? {})) {
      for (const [m, op] of Object.entries(ops2 as Record<string, any>)) {
        if (!["get", "post", "put", "patch", "delete", "options", "head"].includes(m)) continue;
        ops++;
        if (op.requestBody) bodies++;
        if ((op.parameters ?? []).length) opsWithParams++;
        if (Object.keys(op.responses ?? {}).length) opsWithResp++;
      }
    }
    const reasons: Record<string, number> = {};
    for (const u of result.project.unresolved) {
      reasons[u.reason] = (reasons[u.reason] ?? 0) + 1;
    }
    rows.push({
      framework: project.framework,
      paths: Object.keys(doc.paths ?? {}).length,
      ops,
      bodies,
      params: opsWithParams,
      responses: opsWithResp,
      valid: converted.documentValid,
      unresolved: result.project.unresolved.length,
      reasons,
    });
  } catch (error) {
    rows.push({ framework: project.framework, error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
  }
}
console.log(JSON.stringify(rows, null, 1));
