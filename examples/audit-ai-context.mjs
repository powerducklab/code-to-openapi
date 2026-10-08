/** Source-only, isolated per framework; never calls a model or runs corpus code. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const manifest=JSON.parse(readFileSync('test-corpus/real-apis/manifest.json','utf8'));
const out=resolve(process.argv[2]??'/tmp/powerduck-ai-context-audit');mkdirSync(out,{recursive:true});
const rows=[];
for(const [framework,projects] of Object.entries(manifest.frameworks)){
 if(process.argv[3]&&process.argv[3]!=='--all'&&framework!==process.argv[3])continue;
 for(const project of projects){
  const started=Date.now();
  const code=`import {scanProject} from './src/index.ts';
const r=await scanProject({root:process.argv[1],frameworks:[process.argv[2]],aiReview:'manual',reviewAll:true});
const reviews=r.gapReviews??[];
console.log(JSON.stringify({operations:r.project.operations.length,reviews:reviews.length,missing:reviews.filter(q=>!q.request.sourceContext?.files.length).length,unsupported:reviews.filter(q=>q.request.sourceContext?.limitations?.some(s=>s.includes('traversal is unavailable'))).length,multiFile:reviews.filter(q=>(q.request.sourceContext?.files.length??0)>1).length,truncated:reviews.filter(q=>q.request.sourceContext?.truncated).length,samples:reviews.slice(0,3).map(q=>({method:q.method,path:q.path,files:q.request.sourceContext?.files.map(f=>f.file),limitations:q.request.sourceContext?.limitations,unavailable:q.request.sourceContext?.unavailable.slice(0,8)}))}));`;
  const run=spawnSync(process.execPath,['--max-old-space-size=3072','--import','tsx','--input-type=module','-e',code,resolve('test-corpus/real-apis',project.scanRoot),framework],{encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
  let row={framework,repo:project.repo,commit:project.commit,ms:Date.now()-started};
  try{if(run.status!==0)throw new Error(run.stderr||String(run.error));row={...row,...JSON.parse(run.stdout.trim())};}catch(error){row.error=String(error).slice(-1200);}
  rows.push(row);writeFileSync(resolve(out,'summary.json'),JSON.stringify(rows,null,2));
  console.log(JSON.stringify({...row,samples:undefined}));
  if(!process.argv.includes('--all')&&row.operations>0&&row.reviews>0)break;
 }
}
