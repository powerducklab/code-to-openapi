import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('uses actual Prisma select keys instead of exposing full cast entities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'express-select-'));
 try {
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*','@prisma/client':'*'}}));
 await writeFile(join(root,'app.ts'),`import express from 'express';import {PrismaClient as Client} from '@prisma/client';
interface User {id:number;email:string|null;password:string;image:string|undefined}
const db=new Client();
async function fetchUser(){const user=(await db.user.findUnique({select:{id:true,email:true,password:false}})) as User;return {...user,token:'token'};}
const app=express();app.get('/user',async(req,res)=>{const user=await fetchUser();res.json({user});});
app.get('/raw',async(req,res)=>res.json(await db.user.findUnique({select:{id:true}})));
app.post('/input',(req:express.Request<any,any,User>,res)=>res.json({ok:true}));
class Fake{findUnique(options:any){return {password:'legitimate-fake-output'}}};const fake=new Fake();
app.get('/fake',(req,res)=>res.json(fake.findUnique({select:{id:true}})));
app.get('/mutated',(req,res)=>{const value={password:'secret'};delete value.password;res.json(value);});`);
 const result=await scanProject({root});const converted=await result.convert();const doc=converted.document as any;
 expect(converted.documentValid).toBe(true);
 const get=(path:string)=>doc.paths[path].get.responses['200'].content['application/json'].schema;
 expect(Object.keys(get('/user').properties.user.properties).sort()).toEqual(['email','id','token']);
 expect(get('/raw').anyOf).toContainEqual({type:'null'});
 expect(get('/fake').properties.password).toBeDefined();
 expect(get('/mutated').properties?.password).toBeUndefined();
 expect(result.project.operations.find(o=>(o.fullPath??o.path)==='/mutated')?.gaps).toContain('response-schema-unknown');
 expect(doc.components.schemas.User.properties.email.type).toEqual(['string','null']);
 expect(doc.components.schemas.User.required).not.toContain('image');
 }finally{await rm(root,{recursive:true,force:true});}
});
