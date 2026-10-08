/** Source-only Electron worker measurement; does not execute the scanned app.
 * Usage: ELECTRON_RUN_AS_NODE=1 Electron examples/audit-scan-responsiveness.mjs worker-source project-root output.json
 */
import {Worker} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [workerSource,root,output]=process.argv.slice(2).map(value=>resolve(value));
const source=createRequire(import.meta.url)(workerSource);
const worker=new Worker(source,{eval:true,workerData:{scannerUrl:pathToFileURL(resolve('dist/index.js')).href}});
const started=performance.now();let last=started,maxHostDelayMs=0,peakRssBytes=process.memoryUsage().rss,samples=0;
const heartbeat=setInterval(()=>{const now=performance.now();maxHostDelayMs=Math.max(maxHostDelayMs,now-last-20);last=now;peakRssBytes=Math.max(peakRssBytes,process.memoryUsage().rss);samples++;},20);
try{
 const result=await new Promise((accept,reject)=>{
  const timeout=setTimeout(()=>{cleanup();reject(new Error('Scan exceeded 120 seconds'));},120000);
  const cleanup=()=>{clearTimeout(timeout);worker.off('message',message);worker.off('error',failure);worker.off('exit',exit);};
  const failure=error=>{cleanup();reject(error);};
  const exit=code=>failure(new Error(`Worker exited ${code}`));
  const message=value=>{if(value.id!=='measure'||(!value.result&&!value.error))return;cleanup();value.error?reject(new Error(value.error)):accept(value.result);};
  worker.on('message',message);worker.on('error',failure);worker.on('exit',exit);
  worker.postMessage({id:'measure',root,options:{aiReview:'manual'}});
 });
 assert.equal(result.documentValid,true);assert.ok(result.project.operations.length>0);
 // Include transfer/deserialization of the final result in the host measurement.
 await new Promise(resolve=>setTimeout(resolve,25));
 writeFileSync(output,JSON.stringify({runtime:process.versions,root,scope:'Source-only scan in desktop worker; host timer measurement, not a GUI or endpoint runtime test',elapsedMs:performance.now()-started,maxHostDelayMs,peakRssBytes,samples,operations:result.project.operations.length,report:result.report,documentValid:result.documentValid},null,2)+'\n');
 console.log(JSON.stringify({operations:result.project.operations.length,maxHostDelayMs,peakRssBytes}));
}finally{clearInterval(heartbeat);await worker.terminate();}
