import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('identifies synchronous JWT signing through import aliases while leaving callbacks and unrelated methods opaque',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jwt-binding-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*',jsonwebtoken:'*'}}));
  await writeFile(join(root,'app.js'),`import express from 'express';import jwt from 'jsonwebtoken';import {sign as issue} from 'jsonwebtoken';const {sign:common}=require('jsonwebtoken');const app=express();
app.get('/default',(req,res)=>res.json({token:jwt.sign({},'key')}));
app.get('/named',(req,res)=>res.json({token:issue({},'key',{expiresIn:'1h'})}));
app.get('/common',(req,res)=>res.json({token:common({},'key')}));
app.get('/callback',(req,res)=>res.json({token:jwt.sign({},'key',callback)}));
app.get('/four',(req,res)=>res.json({token:jwt.sign({},'key',{},callback)}));
app.get('/opaque',(req,res)=>{const jwt=getExternal();res.json({token:jwt.sign({},'key')})});
`);
  const r=await scanProject({root,frameworks:['express']});
  for(const path of ['/default','/named','/common']) {
   const op=r.project.operations.find(o=>o.path===path)!;
   expect(op.responses[0].content?.[0]?.schema).toMatchObject({properties:{token:{type:'string'}}});
   expect(op.gaps).not.toContain('response-schema-unknown');
  }
  for(const path of ['/callback','/four','/opaque'])expect(r.project.operations.find(o=>o.path===path)?.gaps).toContain('response-schema-unknown');
  expect((await r.convert({validate:true})).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
