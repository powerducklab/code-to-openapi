import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('retains actual Array.map projection keys without exposing the source entity',async()=>{
 const root=await mkdtemp(join(tmpdir(),'array-projection-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
 await writeFile(join(root,'app.ts'),`import express from 'express';
interface User{id:number;name:string;password:string}
const users:User[]=[{id:1,name:'Ada',password:'secret'}];
const app=express();
app.get('/projection',(req,res)=>res.json(users.map((user:User,index)=>({id:user.id,label:user.name,index}))));
app.get('/fake',(req,res)=>res.json(({map:()=>({actual:'object'})}).map()));
app.get('/mutated',(req,res)=>res.json(users.map((user:User)=>{(user as any).id='changed';return {id:user.id}})));
`);
 const doc=(await (await scanProject({root})).convert()).document as any;
 const schema=(path:string)=>doc.paths[path].get.responses['200'].content['application/json'].schema;
 const item=schema('/projection').items;
 expect(schema('/projection').type).toBe('array');
 expect(Object.keys(item.properties).sort()).toEqual(['id','index','label']);
 expect(item.properties.label.type).toBe('string');
 expect(item.properties.index).toMatchObject({type:'integer',minimum:0});
 expect(schema('/fake').type).not.toBe('array');
 expect(schema('/mutated').items.properties.id.type).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
