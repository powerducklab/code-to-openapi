import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('reads destructured CommonJS Joi shorthand bodies with required and nested constraints',async()=>{
 const root=await mkdtemp(join(tmpdir(),'joi-shorthand-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'4',joi:'13','express-validation':'1'}}));
 await writeFile(join(root,'rules.js'),`const Joi=require('joi');module.exports={changeCredentials:{body:{email:Joi.string().email().required(),password:Joi.string().required().min(6).max(128),resetToken:Joi.string().required(),details:{label:Joi.string().max(20)}}}};`);
 await writeFile(join(root,'app.js'),`const express=require('express');const validate=require('express-validation');const {changeCredentials:rules}=require('./rules');const app=express();app.post('/reset',validate(rules),(req,res)=>{const {email,password,resetToken}=req.body;res.json('Password Updated')});`);
 const result=await scanProject({root,frameworks:['express']});
 const operation=result.project.operations[0]!;
 expect(operation.requestBody?.content[0]?.schema).toEqual({type:'object',properties:{email:{type:'string',format:'email'},password:{type:'string',minLength:6,maxLength:128},resetToken:{type:'string'},details:{type:'object',properties:{label:{type:'string',maxLength:20}}}},required:['email','password','resetToken']});
 expect(operation.gaps).not.toContain('body-schema-unknown');
 expect(operation.responses[0]?.content?.[0]?.schema).toEqual({type:'string',const:'Password Updated'});
 expect((await result.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true})}
});
