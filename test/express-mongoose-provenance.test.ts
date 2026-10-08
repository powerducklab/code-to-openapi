import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';

it('tracks registered authentication strategies, injected request fields, save promises and model identity across files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mongoose-provenance-'));
 try{
  const files:Record<string,string>={
   'package.json':JSON.stringify({dependencies:{express:'4',mongoose:'5',passport:'0.6','passport-jwt':'4',lodash:'4'}}),
   'models.js':`const odm=require('mongoose');
const primary=new odm.Schema({label:String,privateKey:String},{timestamps:true});
primary.statics={async fetchOne(id){const record=await this.findById(id);if(record)return record;throw new Error('missing')}};
primary.method({toPublic(){const output={};const names=['id','label','createdAt'];names.forEach(k=>{output[k]=this[k]});return output}});
const alternate=new odm.Schema({code:Number,secret:String});
alternate.method({toPublic(){return {serial:this.code}}});
exports.Item=odm.model('Item',primary);exports.Alternate=odm.model('Alternate',alternate);`,
   'strategies.js':`const Token=require('passport-jwt').Strategy;const {Item,Alternate}=require('./models');
const verify=async(payload,complete)=>{try{const found=await Item.findById(payload.sub);if(found)return complete(null,found);return complete(null,false)}catch(error){return complete(error,false)}};
exports.primary=new Token({},verify);
exports.secondary=new Token({},async(payload,complete)=>{const found=await Alternate.findById(payload.sub);return complete(null,found)});`,
   'auth.js':`const security=require('passport');
const receive=(request,advance)=>(error,principal)=>{if(error||!principal)return advance(error);request.identity=principal;return advance()};
exports.gate=()=> (request,response,advance)=>security.authenticate('inventory',{},receive(request,advance))(request,response,advance);`,
   'controllers.js':`const {Item}=require('./models');const {omit:except}=require('lodash');
exports.load=async(input,output,next,id)=>{const item=await Item.fetchOne(id);input.locals={item};next()};
exports.profile=(input,output)=>output.json(input.identity.toPublic());
exports.defaultProfile=(input,output)=>output.json(input.user.toPublic());
exports.patch=(input,output)=>{const changes=except(input.body,'privateKey');const record=Object.assign(input.locals.item,changes);record.save().then(saved=>output.json(saved.toPublic()))};
exports.awaitSave=async(input,output)=>{const saved=await input.locals.item.save();output.json(saved.toPublic())};
exports.badCallback=(input,output)=>input.locals.item.save().then((saved,notTheResult)=>output.json(notTheResult.toPublic()));
exports.badMerge=(input,output)=>{const record=Object.assign({},input.locals.item);record.save().then(saved=>output.json(saved.toPublic()))};
exports.opaque=(input,output)=>{const record=Object.assign(input.locals.item,untrusted());record.save().then(saved=>output.json(saved.toPublic()))};`,
   'app.js':`const express=require('express');const security=require('passport');const strategies=require('./strategies');const c=require('./controllers');const {gate}=require('./auth');
security.use('inventory',strategies.primary);security.use('alternate',strategies.secondary);
security.use('ambiguous',strategies.primary);security.use('ambiguous',strategies.secondary);
const app=express();app.param('itemId',c.load);
app.get('/identity',gate(),c.profile);
app.get('/default',security.authenticate('inventory',{session:false}),c.defaultProfile);
app.get('/alternate',security.authenticate('alternate'),c.defaultProfile);
app.get('/ambiguous',security.authenticate('ambiguous'),c.defaultProfile);
app.get('/missing',security.authenticate('missing'),c.defaultProfile);
const impostor={authenticate(){return (req,res,next)=>next()}};
app.get('/impostor',impostor.authenticate('inventory'),c.defaultProfile);
app.patch('/items/:itemId',c.patch);app.patch('/await/:itemId',c.awaitSave);
app.patch('/bad-callback/:itemId',c.badCallback);app.patch('/bad-merge/:itemId',c.badMerge);app.patch('/opaque/:itemId',c.opaque);`
  };
  for(const [file,source]of Object.entries(files))await writeFile(join(root,file),source);
  const result=await scanProject({root,frameworks:['express']});
  expect((await result.convert()).documentValid).toBe(true);
  const schema=(path:string)=>result.project.operations.find(op=>op.path===path)?.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema;
  for(const path of ['/identity','/default','/items/{itemId}','/await/{itemId}']){
   expect(schema(path)?.properties,path).toEqual({id:{type:'string'},label:{type:'string'},createdAt:{type:'string',format:'date-time'}});
  }
  expect(schema('/alternate')?.properties).toEqual({serial:{type:'number'}});
  for(const path of ['/ambiguous','/missing','/impostor','/bad-callback/{itemId}','/bad-merge/{itemId}','/opaque/{itemId}']){
   expect(result.project.operations.find(op=>op.path===path)?.gaps,path).toContain('response-schema-unknown');
   expect(schema(path)?.properties,path).toBeUndefined();
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
