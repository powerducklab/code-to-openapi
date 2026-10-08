import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';

it('follows router.param model provenance and interprets renamed instance projections without leaking private fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mongoose-loader-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'4',mongoose:'5'}}));
  await writeFile(join(root,'model.js'),`const mongoose=require('mongoose');
const schema=new mongoose.Schema({email:{type:String,required:true},nickname:String,password:String,role:{type:String,default:'reader'}},{timestamps:true});
schema.statics={async fetchRecord(id){let member;if(id){member=await this.findById(id).exec()}if(member)return member;throw new Error('missing')}};
schema.method({
 publicView(){const result={};const selected=['id','nickname','email','role','createdAt'];selected.forEach(key=>{result[key]=this[key]});return result},
 unsafeView(){const result={};const selected=['email'];selected.forEach(key=>{result[key]=this[key]});mutate(result);return result}
});
module.exports=mongoose.model('Member',schema);`);
  await writeFile(join(root,'controller.js'),`const Member=require('./model');
exports.load=async(request,response,next,id)=>{try{const member=await Member.fetchRecord(id);request.locals={member};return next()}catch(error){return next(error)}};
exports.get=(input,output)=>output.json(input.locals.member.publicView());
exports.unsafe=(input,output)=>output.json(input.locals.member.unsafeView());
`);
  await writeFile(join(root,'app.js'),`const express=require('express');const c=require('./controller');
const app=express();const router=express.Router();router.param('memberId',c.load);
router.get('/members/:memberId',c.get);router.get('/unsafe/:memberId',c.unsafe);
router.get('/unbound/:otherId',c.get);
const other=express.Router();other.get('/isolated/:memberId',c.get);
app.use('/v2',router);app.use('/v2',other);`);
  const result=await scanProject({root,frameworks:['express']});
  const converted=await result.convert();
  expect(converted.documentValid).toBe(true);
  const operation=result.project.operations.find(op=>op.path==='/v2/members/{memberId}')!;
  const schema=operation.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema;
  expect(schema?.properties).toEqual({id:{type:'string'},nickname:{type:'string'},email:{type:'string'},role:{type:'string'},createdAt:{type:'string',format:'date-time'}});
  expect(schema?.required).toEqual(['id','email','role','createdAt']);
  expect(operation.gaps).not.toContain('response-schema-unknown');
  for(const path of ['/v2/unbound/{otherId}','/v2/isolated/{memberId}','/v2/unsafe/{memberId}']) {
   const op=result.project.operations.find(op=>op.path===path)!;
   expect(op.gaps,path).toContain('response-schema-unknown');
   expect(JSON.stringify(op.responses),path).not.toContain('password');
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
