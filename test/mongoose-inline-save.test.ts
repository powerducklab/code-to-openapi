import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('projects inline saves through registered model imports across Express and Koa without matching arbitrary save methods',async()=>{
 const root=await mkdtemp(join(tmpdir(),'inline-save-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*',koa:'*','koa-router':'*',mongoose:'*'}}));
  await writeFile(join(root,'model.js'),`import odm from 'mongoose';const schema=new odm.Schema({title:{type:String,required:true},quantity:Number});export const Record=odm.model('Record',schema);const custom=new odm.Schema({title:String});custom.methods.save=function(){return remoteResult()};export const Custom=odm.model('Custom',custom);`);
  await writeFile(join(root,'app.js'),`import express from 'express';import Router from 'koa-router';import {Record as Entry,Custom} from './model.js';import External from 'opaque-library';
const app=express();const router=new Router({prefix:'/koa'});
app.post('/entries',async(req,res)=>{const saved=await new Entry(req.body).save();res.json(saved)});
router.post('/entries',async ctx=>{ctx.body=await (new Entry(ctx.request.body)).save()});
router.post('/override',async ctx=>{ctx.body=await new Custom(ctx.request.body).save()});
router.post('/opaque',async ctx=>{ctx.body=await new External(ctx.request.body).save()});
router.post('/callback',async ctx=>{ctx.body=await new Entry(ctx.request.body).save(callback)});
`);
  for(const framework of ['express','koa']) {
   const r=await scanProject({root,frameworks:[framework]});
   const path=framework==='express'?'/entries':'/koa/entries';
   const op=r.project.operations.find(o=>(o.fullPath??o.path)===path)!;
   expect(op.responses[0].content?.[0]?.schema).toMatchObject({type:'object',properties:{title:{type:'string'},quantity:{type:'number'}},required:expect.arrayContaining(['title'])});
   expect(op.gaps).not.toContain('response-schema-unknown');
   if(framework==='koa')for(const suffix of ['opaque','callback','override'])expect(r.project.operations.find(o=>(o.fullPath??o.path)===`/koa/${suffix}`)?.gaps).toContain('response-schema-unknown');
   expect((await r.convert({validate:true})).documentValid).toBe(true);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
