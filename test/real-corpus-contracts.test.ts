import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { scanProject } from '../src/index.js';

// Source-backed assertions against actual pinned checkouts, not saved scanner
// snapshots. Small standalone tests cover the same semantics without the corpus.
const base=resolve('test-corpus/real-apis/repos');
const fastifyRoot=resolve(base,'fastify/TomDoesTech__fastify-prisma-rest-api');
it.skipIf(!existsSync(fastifyRoot))('real Fastify API preserves registered request and response fields',async()=>{
 const r=await scanProject({root:fastifyRoot,frameworks:['fastify']});
 const find=(method:string,path:string)=>r.project.operations.find(o=>o.method===method&&o.path===path)!;
 // src/modules/user/user.schema.ts: createUserSchema and loginResponseSchema.
 const register=find('post','/api/users');
 expect(register.requestBody?.content[0].schema).toMatchObject({required:['email','name','password'],properties:{email:{type:'string',format:'email'},name:{type:'string'},password:{type:'string'}}});
 const login=find('post','/api/users/login');
 expect(login.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema).toMatchObject({required:['accessToken'],properties:{accessToken:{type:'string'}}});
 // src/modules/product/product.schema.ts: productsResponseSchema is an array.
 const products=find('get','/api/products');
 expect(products.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema).toMatchObject({type:'array',items:{required:['title','price','id','createdAt','updatedAt'],properties:{content:{type:'string'},title:{type:'string'},price:{type:'number'}}}});
 expect(products.gaps).not.toContain('response-schema-unknown');
 expect((await r.convert({validate:true})).documentValid).toBe(true);
},30000);

const flaskRoot=resolve(base,'flask/arsalasif__flask-rest-api');
it.skipIf(!existsSync(flaskRoot))('real Flask logout is concrete while opaque token generation remains unresolved',async()=>{
 const r=await scanProject({root:flaskRoot,frameworks:['flask']});
 // services/web/project/api/v1/auth/core.py: jsonify keyword returns.
 const logout=r.project.operations.find(o=>o.path==='/v1/auth/logout')!;
 expect(logout.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema).toEqual({type:'object',properties:{message:{type:'string'}},required:['message']});
 expect(logout.gaps).not.toContain('response-schema-unknown');
 const login=r.project.operations.find(o=>o.path==='/v1/auth/login')!;
 expect(login.responses[0].content?.[0]?.schema).toMatchObject({properties:{message:{type:'string'},auth_token:{}}});
 expect(login.gaps).toContain('response-schema-unknown');
 expect(login.requestBody?.content[0]?.schema).toMatchObject({required:['email','password'],properties:{email:{type:'string',format:'email'},password:{type:'string'}}});
 expect(login.gaps).not.toContain('body-schema-unknown');
 expect((await r.convert({validate:true})).documentValid).toBe(true);
},30000);

const koaRoot=resolve(base,'koa/jsnomad__koa-restful-boilerplate');
it.skipIf(!existsSync(koaRoot))('real Koa city routes retain constant prefixes and imported controller response fields',async()=>{
 const r=await scanProject({root:koaRoot,frameworks:['koa']});
 const find=(method:string,path:string)=>r.project.operations.find(o=>o.method===method&&(o.fullPath??o.path)===path)!;
 // server/config.js and routes/cities.js compose /api/cities. Authentication
 // is a different router: its POST must not collide with city creation.
 const auth=find('post','/api/authenticate');
 expect(auth.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema).toMatchObject({properties:{token:{type:'string'}}});
 expect(auth.gaps).not.toContain('response-schema-unknown');
 const created=find('post','/api/cities');
 expect(created.responses[0].content?.[0]?.schema).toMatchObject({type:'object',properties:{name:{type:'string'},totalPopulation:{type:'number'}}});
 expect(created.gaps).not.toContain('response-schema-unknown');
 const list=find('get','/api/cities');
 expect(list.responses[0].content?.[0]?.schema).toMatchObject({type:'array',items:{properties:{name:{type:'string'},totalPopulation:{type:'number'},updated:{type:'string',format:'date-time'}}}});
 for(const method of ['get','put','delete']) {
  const op=find(method,'/api/cities/{id}');
  expect(op.responses[0].content?.[0]?.schema).toMatchObject({anyOf:expect.arrayContaining([expect.objectContaining({properties:expect.objectContaining({name:{type:'string'},zipCode:{type:'number'}})})])});
  expect(op.gaps).not.toContain('response-unknown');
  expect(op.gaps).not.toContain('response-schema-unknown');
 }
 expect((await r.convert({validate:true})).documentValid).toBe(true);
},30000);
