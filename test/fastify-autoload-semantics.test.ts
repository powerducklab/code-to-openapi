import { it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/index.js';

it.each([
 ['', '/_id/item'],
 ['routeParams: true,', '/{id}/item'],
 ['encapsulate: false,', '/item'],
])('honors autoload options %s', async (options, expected) => {
 const root=await mkdtemp(join(tmpdir(),'fastify-autoload-'));
 try {
  await mkdir(join(root,'routes','_id'),{recursive:true});
  await writeFile(join(root,'app.js'), `const app=require('fastify')(); const load=require('@fastify/autoload'); const path=require('path');
app.register(load,{dir:path.join(__dirname,'routes'),${options}});`);
  await writeFile(join(root,'routes','_id','index.js'), `module.exports=async function(app){ app.get('/item',async()=>({id:1})); }`);
  const result=await scanProject({root});
  expect(result.project.operations.map(o=>o.path)).toEqual([expected]);
  const converted=await result.convert();
  expect(converted.documentValid).toBe(true);
  expect(converted.document.paths[expected].get.responses['200'].content['application/json'].schema.properties.id.type).toBe('number');
 } finally {await rm(root,{recursive:true,force:true});}
});

it('resolves nested fluent schemas in their defining module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastify-schema-ref-'));
 try {
  await writeFile(join(root,'models.js'),`const S=require('fluent-json-schema'); const User=S.object().prop('name',S.string().required()); module.exports={User};`);
  await writeFile(join(root,'schema.js'),`const S=require('fluent-json-schema'); const models=require('./models'); module.exports={response:{200:S.object().prop('users',S.array().items(models.User).required())}};`);
  await writeFile(join(root,'app.js'),`const app=require('fastify')();const schema=require('./schema');app.get('/users',{schema},async()=>({users:[]}));`);
  const r=await scanProject({root});const c=await r.convert();
  expect(c.document.paths['/users'].get.responses['200'].content['application/json'].schema).toMatchObject({type:'object',required:['users'],properties:{users:{type:'array',items:{type:'object',required:['name'],properties:{name:{type:'string'}}}}}});
 }finally{await rm(root,{recursive:true,force:true});}
});
