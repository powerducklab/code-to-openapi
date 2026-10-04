import {expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('separates Pages Router method branches, guards and switch fallthrough',async()=>{
 const root=await mkdtemp(join(tmpdir(),'next-methods-'));
 try{
  await mkdir(join(root,'pages/api'),{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{next:'13'}}));
  await writeFile(join(root,'pages/api/items.ts'),`export default function handler(req:any,res:any){
   if(req.method==='GET')return res.status(200).json({items:['one']});
   if(req.method==='POST')return res.status(201).json({created:true});
   return res.status(405).end();
  }
  function unused(req:any){if(req.method==='DELETE')return 'unused';}`);
  await writeFile(join(root,'pages/api/guard.ts'),`export default function handler(req:any,res:any){
   const method=req.method;if(method!=='PATCH')return res.status(405).end();
   return res.status(200).json({patched:true});
  }`);
  await writeFile(join(root,'pages/api/switch.ts'),`export default function handler(req:any,res:any){
   switch(req.method){case 'PUT':case 'PATCH':return res.status(200).json({updated:true});default:return res.status(405).end();}
  }`);
  await writeFile(join(root,'pages/api/dynamic-switch.ts'),`export default function handler(req:any,res:any){
   switch(req.method){case process.env.METHOD:return res.status(202).json({accepted:true});default:return res.status(405).end();}
  }`);
  await writeFile(join(root,'pages/api/mutated.ts'),`export default function handler(req:any,res:any){
   req.method='POST';
   if(req.method==='POST')return res.status(201).json({rewritten:true});
   return res.status(405).end();
  }`);
  await writeFile(join(root,'pages/api/escaped.ts'),`export default function handler(req:any,res:any){
   normalize(req);
   if(req.method==='POST')return res.status(201).json({normalized:true});
   return res.status(405).end();
  }`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  expect(Object.keys(doc.paths['/api/items']).sort()).toEqual(['get','post']);
  expect(Object.keys(doc.paths['/api/items'].get.responses)).toEqual(['200']);
  expect(doc.paths['/api/items'].get.responses['200'].content['application/json'].schema.properties).toHaveProperty('items');
  expect(doc.paths['/api/items'].post.responses['201'].content['application/json'].schema.properties).not.toHaveProperty('items');
  expect(Object.keys(doc.paths['/api/guard'])).toEqual(['patch']);
  expect(Object.keys(doc.paths['/api/switch']).sort()).toEqual(['patch','put']);
  expect(doc.paths['/api/dynamic-switch'].get.responses).toHaveProperty('202');
  for(const path of ['/api/mutated','/api/escaped']){
   expect(doc.paths[path].get.responses).toHaveProperty('201');
   expect(result.project.operations.find(operation => operation.method==='get' && operation.path===path)?.gaps).toContain('response-unknown');
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
