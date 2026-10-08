import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scanProject } from '../src/index.js';

it('reads imported TypeBox contracts in their defining scope without installed dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fastify-typebox-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({dependencies:{fastify:'*','@fastify/type-provider-typebox':'*'}}));
    await writeFile(join(root, 'schema.ts'), `import {Type as T} from '@fastify/type-provider-typebox';
const Login = T.Object({email:T.String({format:'email'}),password:T.String({minLength:6}),roles:T.Optional(T.Array(T.String({enum:['USER','ADMIN']})))},{additionalProperties:false});
export const loginSchema = {body:Login,response:{200:T.Object({token:T.String()})}};`);
    await writeFile(join(root, 'app.ts'), `import fastify from 'fastify';import {loginSchema} from './schema';
const app=fastify();app.post('/login',{schema:loginSchema},async(req,reply)=>reply.send(external()));`);
    const result = await scanProject({root});
    const converted = await result.convert();
    expect(converted.documentValid).toBe(true);
    const op = (converted.document as any).paths['/login'].post;
    expect(op.requestBody.content['application/json'].schema).toMatchObject({type:'object',additionalProperties:false,required:['email','password'],properties:{email:{type:'string',format:'email'},password:{type:'string',minLength:6},roles:{type:'array',items:{type:'string',enum:['USER','ADMIN']}}}});
    expect(op.responses['200'].content['application/json'].schema.properties.token.type).toBe('string');
    expect(result.project.operations[0].gaps).toEqual([]);
  } finally { await rm(root, {recursive:true,force:true}); }
});

it('resolves anonymous default exported Fastify plugins inside prefixed registrations', async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastify-default-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{fastify:'*'}}));
  await writeFile(join(root,'routes.ts'),`export default async function(app){ app.post('/',{schema:{body:{type:'object',properties:{name:{type:'string'}},required:['name']}}},async(req,reply)=>reply.send({ok:true})); }`);
  await writeFile(join(root,'app.ts'),`import fastify from 'fastify';import routes from './routes';const app=fastify();app.register(async api=>{api.register(routes,{prefix:'/products'})},{prefix:'/api/v1'});`);
  const r=await scanProject({root});
  expect(r.project.operations.map(o=>o.fullPath??o.path)).toEqual(['/api/v1/products']);
  expect(r.project.operations[0].requestBody?.content[0]?.schema).toMatchObject({required:['name'],properties:{name:{type:'string'}}});
 }finally{await rm(root,{recursive:true,force:true});}
});

it('resolves addSchema IDs, recursive refs, query fields and preserves inferred success beside explicit errors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastify-shared-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{fastify:'*'}}));
  await writeFile(join(root,'schema.ts'),`export const query={$id:'Paging',type:'object',properties:{limit:{type:'integer',minimum:1}},required:['limit']};export const tree={$id:'Tree',type:'object',properties:{name:{type:'string'},children:{type:'array',items:{$ref:'Tree#'}}}};`);
  await writeFile(join(root,'app.ts'),`import fastify from 'fastify';import {query,tree} from './schema';const app=fastify();app.addSchema(query);app.addSchema(tree);
app.get('/trees',{schema:{querystring:{$ref:'Paging'},response:{200:{$ref:'Tree#'}}}},async()=>({}));
app.post('/login',{schema:{response:{401:{type:'object',properties:{error:{type:'string'}}}}}},async()=>({token:'ok'}));`);
  const r=await scanProject({root});const c=await r.convert();expect(c.documentValid,JSON.stringify(c.diagnostics)).toBe(true);
  const d=c.document as any;
  expect(d.paths['/trees'].get.parameters[0]).toMatchObject({name:'limit',required:true,schema:{type:'integer',minimum:1}});
  const schema=d.paths['/trees'].get.responses['200'].content['application/json'].schema;
  expect(schema.properties.name.type).toBe('string');
  const ref=schema.properties.children.items.$ref;
  expect(d.components.schemas[ref.split('/').at(-1)].properties.name.type).toBe('string');
  expect(Object.keys(d.paths['/login'].post.responses).sort()).toEqual(['200','401']);
 }finally{await rm(root,{recursive:true,force:true});}
});
