/** Scan source only: never install or execute code from the audited repository. */
import { scanProject } from '../src/index.js';
import { writeFileSync } from 'node:fs';
const result = await scanProject({ root: process.argv[2]!, additionalSourceRoots: process.argv.slice(4) });
const converted = await result.convert();
writeFileSync(process.argv[3]!, JSON.stringify({
 report: result.report, project: result.project, document: converted.document,
 gapReviews: (result as { gapReviews?: unknown[] }).gapReviews ?? [],
 valid: converted.documentValid, ok: converted.ok, diagnostics: converted.diagnostics,
}, null, 2));
