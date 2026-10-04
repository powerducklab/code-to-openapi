/** Exercise the real Electron scan-worker adapter against all six WASM grammars.
 * Usage: ELECTRON_RUN_AS_NODE=1 /path/to/Electron audit-worker-lifecycle.mjs /path/to/code-scan-worker-source.js output.json
 */
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,dirname} from 'node:path';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=createRequire(import.meta.url)(resolve(process.argv[2]));
const output=resolve(process.argv[3]);
const cases=[['laravel-php','laravel'],['axum-rs','axum'],['spring-java','spring'],['aspnet-csharp','aspnet'],['gin-go','gin'],['fastapi-py','fastapi']];
const results=[];
for(let round=0;round<3;round++){
 const worker=new Worker(source,{eval:true,workerData:{scannerUrl:pathToFileURL(resolve(root,'dist/index.js')).href}});
 try{
  for(const [fixture,framework] of cases){
   const id=`${round}-${framework}`;
   const message=await new Promise((accept,reject)=>{
    const cleanup=()=>{clearTimeout(timer);worker.off('message',received);worker.off('error',failed);worker.off('exit',exited);};
    const received=value=>{if(value.id===id){cleanup();accept(value);}};
    const failed=error=>{cleanup();reject(error);};
    const exited=code=>failed(new Error(`Worker exited ${code}`));
    const timer=setTimeout(()=>failed(new Error('Worker scan timeout')),60000);
    worker.on('message',received);worker.on('error',failed);worker.on('exit',exited);
    worker.postMessage({id,root:resolve(root,'test/fixtures',fixture),options:{includeTests:true}});
   });
   assert.equal(message.error,undefined);
   assert.equal(message.result.documentValid,true);
   assert.ok(message.result.report.frameworks.includes(framework));
   assert.ok(message.result.project.operations.length>0);
   results.push({round,framework,routes:message.result.project.operations.length});
   writeFileSync(output,JSON.stringify({versions:process.versions,completed:false,scans:results},null,2)+'\n');
  }
 }finally{await worker.terminate();}
}
writeFileSync(output,JSON.stringify({versions:process.versions,completed:true,scans:results},null,2)+'\n');
console.log(`${results.length} scans passed across ${cases.length} grammars and three worker lifecycles`);
