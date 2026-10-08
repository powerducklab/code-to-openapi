import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('narrows shared handler and helper body reads by registered HTTP method',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastify-method-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{fastify:'5'}}));
 await writeFile(join(root,'app.ts'),`import Fastify from 'fastify';
const app=Fastify();
function serve(req, reply) {const body=req.method === 'POST' ? req.body : undefined; reply.send({ok:true});}
app.route({method:['GET','POST','DELETE'],url:'/shared',handler:async(request,reply)=>{await serve(request,reply);}});
app.delete('/valid-body',async(req,reply)=>{const data=req.body; reply.send({ok:true});});
app.route({method:['POST','DELETE'],url:'/branch',handler:async(req,reply)=>{if ('POST' === req.method) {const data=req.body;} reply.send({ok:true});}});
app.get('/unknown',async(req,reply)=>{if (enabled) {const data=req.body;} reply.send({ok:true});});
`);
 const r=await scanProject({root,frameworks:['fastify']});
 for(const path of ['/shared','/branch'])for(const op of r.project.operations.filter(o=>o.path===path)){
  expect(Boolean(op.requestBody),op.method+' '+path).toBe(op.method==='post');
  expect(op.gaps.includes('body-schema-unknown')).toBe(op.method==='post');
 }
 expect(r.project.operations.find(o=>o.path==='/valid-body')?.requestBody).toBeDefined();
 expect(r.project.operations.find(o=>o.path==='/unknown')?.requestBody).toBeDefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
