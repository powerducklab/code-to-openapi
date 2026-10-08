import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanProject } from '../src/index.js';

it('keeps different object branches and does not erase unresolved alternatives', async () => {
 const root=await mkdtemp(join(tmpdir(),'branch-contract-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.ts'),`import express from 'express';const app=express();
app.get('/choice',(req,res)=>res.json(req.query.choice?{name:'reader'}:{count:2}));
app.get('/unknown',(req,res)=>res.json(req.query.choice?{name:'reader'}:external()));
app.get('/fallback',(req,res)=>res.json(external()||{count:2}));
app.get('/same',(req,res)=>res.json(req.query.choice?{count:1}:{count:1}));`);
  const result=await scanProject({root,frameworks:['express']});
  const op=(path:string)=>result.project.operations.find(o=>o.path===path)!;
  const schema=(path:string)=>op(path).responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema;
  expect(schema('/choice')).toMatchObject({anyOf:[{properties:{name:{type:'string'}}},{properties:{count:{type:'integer'}}}]});
  for(const path of ['/unknown','/fallback']) {
   expect(op(path).gaps).toContain('response-schema-unknown');
   expect(schema(path)?.anyOf).toContainEqual({});
  }
  expect(schema('/same')).toMatchObject({type:'object',properties:{count:{type:'integer'}}});
 }finally{await rm(root,{recursive:true,force:true})}
});
