/** Compare sequential real-corpus scans and retain an inventory of every API.
 * Usage: node examples/compare-corpus-audit.mjs <before-dir> <after-dir> <output-dir>
 * These are static findings, not claims of live endpoint or field accuracy.
 */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const [beforeDir,afterDir,outDir]=process.argv.slice(2).map(p=>resolve(p));
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const before=read(resolve(beforeDir,'summary.json'));
const after=read(resolve(afterDir,'summary.json'));
const beforeById=new Map(before.map(row=>[row.id,row]));
const totals=rows=>({checkpoints:rows.length,scanned:rows.filter(r=>r.status==='scanned').length,failed:rows.filter(r=>r.status==='failed').length,missing:rows.filter(r=>r.status==='missing').length,zeroOperations:rows.filter(r=>r.status==='scanned'&&r.operations===0).length,operations:rows.reduce((sum,r)=>sum+(r.operations??0),0),operationsWithGaps:rows.reduce((sum,r)=>sum+(r.partial??0),0),invalidDocuments:rows.filter(r=>r.status==='scanned'&&r.valid!==true).length});
const endpoints=[];
for(const row of after){
 if(row.status!=='scanned')continue;
 const result=read(resolve(afterDir,row.id+'.json'));
 const prior=beforeById.get(row.id)?.status==='scanned'?read(resolve(beforeDir,row.id+'.json')):null;
 const identity=op=>`${op.method} ${op.fullPath??op.path}`;
 const old=new Map((prior?.project.operations??[]).map(op=>[identity(op),op]));
 for(const op of result.project.operations){
  const previous=old.get(identity(op));
  endpoints.push({checkpoint:row.id,framework:row.framework,repo:row.repo,commit:row.commit,method:op.method,path:op.fullPath??op.path,source:op.origin,confidence:op.confidence,gaps:op.gaps??[],previousGaps:previous?.gaps??null,contractChanged:previous?JSON.stringify([previous.parameters,previous.requestBody,previous.responses])!==JSON.stringify([op.parameters,op.requestBody,op.responses]):null,parameters:op.parameters,requestBody:op.requestBody,responses:op.responses});
 }
}
mkdirSync(outDir,{recursive:true});
writeFileSync(resolve(outDir,'summary.json'),JSON.stringify({scope:'Static source scan and OpenAPI validation; independent source assertions are in test/real-corpus-contracts.test.ts. No corpus application was executed.',before:totals(before),after:totals(after),projects:after},null,2)+'\n');
writeFileSync(resolve(outDir,'endpoints.json'),JSON.stringify(endpoints,null,2)+'\n');
const csv=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const rows=[['checkpoint','method','path','source','line','gaps','previous_gaps','contract_changed'],...endpoints.map(e=>[e.checkpoint,e.method,e.path,e.source?.file,e.source?.line,e.gaps.join(';'),e.previousGaps?.join(';'),e.contractChanged])];
writeFileSync(resolve(outDir,'endpoints.csv'),rows.map(row=>row.map(csv).join(',')).join('\n')+'\n');
console.log(JSON.stringify({before:totals(before),after:totals(after),changedContracts:endpoints.filter(e=>e.contractChanged).length},null,2));
