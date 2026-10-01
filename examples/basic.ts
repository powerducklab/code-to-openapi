/**
 * Minimal end-to-end example:
 *   npx tsx examples/basic.ts /path/to/express-project
 *
 * Prints the discovered routes report and the validated OpenAPI 3.2 document.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { scanProject } from "../dist/index.js";

const root = resolve(process.argv[2] ?? ".");

const result = await scanProject({ root });

console.log("Frameworks:", result.report.frameworks.join(", ") || "none");
console.log("Files scanned:", result.report.filesScanned);
console.log(
  "Routes:",
  `${result.report.routesConfirmed} confirmed, ${result.report.routesPartial} partial`,
);
for (const op of result.project.operations) {
  console.log(
    `  ${op.method.toUpperCase().padEnd(6)} ${op.path}  [${op.confidence}]`,
  );
}
for (const item of result.report.gaps) {
  console.log(`  gap ${item.route}: ${item.gaps.join(", ")}`);
}

const converted = await result.convert();
console.log("Document valid:", converted.documentValid);

writeFileSync(
  resolve("discovered.openapi.json"),
  JSON.stringify(converted.document, null, 2),
);
console.log("Wrote discovered.openapi.json");
