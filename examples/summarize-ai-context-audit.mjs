import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
const input=resolve(process.argv[2]??'/tmp/powerduck-ai-context-release/summary.json');
const output=resolve(process.argv[3]??'reports/ai-context-audit.json');
const rows=JSON.parse(readFileSync(input,'utf8'));
const manifest=JSON.parse(readFileSync('test-corpus/real-apis/manifest.json','utf8'));
const frameworks=Object.keys(manifest.frameworks).map(framework=>{
 const projects=rows.filter(row=>row.framework===framework);
 const sum=key=>projects.reduce((n,row)=>n+(row[key]??0),0);
 return {framework,checkpoints:projects.length,expectedCheckpoints:manifest.frameworks[framework].length,
  scanned:projects.filter(row=>!row.error).length,failed:projects.filter(row=>row.error).length,
  zeroOperations:projects.filter(row=>row.operations===0).length,operations:sum('operations'),reviews:sum('reviews'),
  multiFileContexts:sum('multiFile'),truncatedContexts:sum('truncated'),emptyContexts:sum('missing'),unsupportedTraversal:sum('unsupported')};
});
const report={generatedAt:new Date().toISOString(),promptVersion:'2026-10-08d',
 scope:'Source-only static context collection; no model calls, corpus dependency installation, or corpus application execution.',
 interpretation:'Nonempty context and supported traversal do not prove semantic completeness. Truncation, external dependencies, dynamic dispatch and unresolved handlers remain explicit limitations.',
 totals:Object.fromEntries(['checkpoints','scanned','failed','zeroOperations','operations','reviews','multiFileContexts','truncatedContexts','emptyContexts','unsupportedTraversal'].map(key=>[key,frameworks.reduce((n,row)=>n+row[key],0)])),
 frameworks,projects:rows};
if(frameworks.some(row=>row.checkpoints!==row.expectedCheckpoints))throw new Error('Audit is incomplete; checkpoint counts do not match manifest');
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report.totals,null,2));
