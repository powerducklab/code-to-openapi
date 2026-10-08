import {expect,it} from 'vitest';
import {resolve} from 'node:path';
import {scanProject,buildGapMessages,applyGapDecision,buildGapReview} from '../src/index.js';
const fixtures = [
 ['express','express-ts'],['fastify','fastify-ts'],['nest','nest-ts'],['hono','hono-edge'],['koa','koa-edge'],['nextjs','nextjs-edge'],['elysia','elysia-edge'],
 ['gin','gin-go'],['chi','chi-go'],['nethttp','nethttp-edge'],['gorillamux','gorillamux-edge'],['echo','echo-edge'],['fiber','fiber-edge'],
 ['fastapi','fastapi-py'],['flask','flask-py'],['drf','drf-py'],['starlette','starlette-py'],
 ['spring','spring-java'],['jaxrs','jaxrs-shop'],['micronaut','micronaut-books'],
 ['aspnet','aspnet-csharp'],['fastendpoints','fastendpoints-basic'],
 ['axum','axum-rs'],['actix','actix-basic'],['rocket','rocket-basic'],
 ['laravel','laravel-php'],['symfony','symfony-basic'],['slim','slim-basic'],
];
it.each(fixtures)('%s exposes bounded source evidence and current contracts to AI',async(framework,fixture)=>{
 const result=await scanProject({root:resolve('test/fixtures',fixture!),frameworks:[framework!],aiReview:'manual',reviewAll:true});
 expect(result.project.operations.length).toBeGreaterThan(0);
 expect(result.gapReviews?.length).toBeGreaterThan(0);
 for(const review of result.gapReviews!){
  const context=review.request.sourceContext!;
  expect(context.files.length).toBeGreaterThan(0);
  expect(context.files.reduce((n,f)=>n+f.source.length,0)).toBeLessThanOrEqual(24000);
  expect(context.limitations?.some(s=>s.includes('traversal is unavailable'))).toBe(false);
  expect(buildGapMessages(review.request)[1]!.content).toContain('currentContract');
  const operation=result.project.operations.find(op=>op.method.toLowerCase()===review.method.toLowerCase()&&op.path===review.path)!;
  const protectedResponses=operation.responses.filter(r=>!r.content?.length || r.content.every(m=>m.mediaType!=='application/json'));
  const proposal:any={responseSchemas:Object.fromEntries(protectedResponses.map(r=>[r.statusCode,{type:'object',properties:{invented:{type:'string'}}}])),confidence:'high'};
  const applied=applyGapDecision([operation],review,{action:'accept',resolution:proposal});
  for(const response of protectedResponses) expect(applied.operation.responses.find(r=>r.statusCode===response.statusCode)).toEqual(response);
  // Each framework must preserve known fields when another leaf is unresolved.
  const partial:any={...operation,gaps:['body-schema-unknown'],requestBody:{required:true,content:[{mediaType:'application/json',schema:{type:'object',properties:{email:{type:'string',minLength:1},unknown:{}},required:['email']}}]}};
  const gapReview=buildGapReview({...partial,fullPath:partial.path,handlerSource:review.request.handlerSource},[],true)!;
  const merged=applyGapDecision([partial],gapReview,{action:'accept',resolution:{bodySchema:{type:'object',properties:{unknown:{type:'integer'}}},confidence:'high'}});
  expect(merged.operation.requestBody?.content[0]?.schema).toMatchObject({properties:{email:{type:'string',minLength:1},unknown:{type:'integer'}},required:['email']});
 }
});
