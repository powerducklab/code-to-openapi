/** Reproducible source-fixture scan; does not execute target applications or call AI. */
import { scanProject } from '../src/index.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cases=[['TypeScript','express-ts'],['JavaScript','express-js'],['Python','fastapi-py'],['Go','gin-go'],['Java','spring-java'],['C#','aspnet-csharp'],['Rust','axum-rs'],['PHP','laravel-php']];
const rows=[];
for(const [language,fixture] of cases){
 const start=performance.now();
 const r=await scanProject({root:resolve(root,'test/fixtures',fixture!),includeTests:true});
 const converted=await r.convert();
 if(!converted.ok || !converted.documentValid || !r.project.operations.length) throw new Error(`Invalid scan: ${fixture}`);
 rows.push({language,fixture,operations:r.project.operations.length,partial:r.report.routesPartial,gaps:r.report.gaps,valid:converted.documentValid,ms:Math.round(performance.now()-start)});
}
console.log(JSON.stringify(rows,null,2));
