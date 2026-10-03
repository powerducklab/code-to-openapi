import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanProject } from '../src/core/engine.js';
import { buildSidecar, diffSidecars } from '../src/core/sidecar.js';

describe('contract accuracy regressions', () => {
 it('detects referenced DTO changes without modifying a handler, including cycles', () => {
  const operation: any = {method:'get',path:'/users',origin:{file:'app.ts'},confidence:'high',responses:[{statusCode:'200',description:'',confidence:'high',content:[{mediaType:'application/json',schema:{$ref:'#/components/schemas/User'}}]}]};
  const input: any = {files:[{path:'app.ts',hash:'same'}],operations:[operation]};
  const components = (type: string) => [{name:'User',schema:{type:'object',properties:{id:{type},parent:{$ref:'#/components/schemas/User'}}}}];
  const before=buildSidecar({...input,components:components('string')});
  const after=buildSidecar({...input,components:components('integer')});
  expect(diffSidecars(before,after).routeChanges.map(r=>r.kind)).toEqual(['changed']);
  expect(diffSidecars(after,buildSidecar({...input,components:[...components('integer'),{name:'Unused',schema:{type:'boolean'}}]})).routeChanges).toEqual([]);
 });
 it('keeps response alternatives and excludes nested access names from top-level parameters', async () => {
  const root=await mkdtemp(join(tmpdir(),'pd-contract-'));
  try {
   await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{fastify:'*'}}));
   await writeFile(join(root,'app.ts'),`import Fastify from 'fastify';
const app=Fastify();
app.get('/branch', async (request: any) => {
 const text=request.query.search.toLowerCase();
 const token=request.headers['x-token'];
 if(text) return { user: { id: 'one' } };
 return { error: 'missing' };
});`);
   const result=await scanProject({root});
   const op=result.project.operations.find(o=>o.path==='/branch')!;
   expect(op).toBeTruthy();
   expect(op.parameters?.map(p=>p.name)).toEqual(['search','x-token']);
   const schema:any=op.responses.find(r=>r.statusCode==='200')?.content?.[0]?.schema;
   expect(schema.anyOf).toHaveLength(2);
   expect(schema.anyOf.map((s:any)=>Object.keys(s.properties)[0]).sort()).toEqual(['error','user']);
   expect((await result.convert()).documentValid).toBe(true);
  } finally { await rm(root,{recursive:true,force:true}); }
 });
});

it('preserves explicitly declared redirect response bodies', async () => {
 const {applyCompletenessGate}=await import('../src/core/completeness.js');
 const route:any={method:'get',path:'/redirect',fullPath:'/redirect',parameters:[],gaps:[],confidence:'high',responses:[{statusCode:'302',confidence:'high',content:[{mediaType:'text/html',schema:{type:'string'}}]}]};
 expect(applyCompletenessGate(route).responses[0]?.content?.[0]?.schema).toEqual({type:'string'});
});

it('recognizes real-world Starlette decorator registration and named route lists', async () => {
 const root=await mkdtemp(join(tmpdir(),'pd-starlette-'));
 try {
  // Registration patterns from gtfisher/starlette-example-crud and Starlette docs.
  await writeFile(join(root,'app.py'),`from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import JSONResponse
async def listed(request):
    return JSONResponse({'ok': True})
routes = [Route('/listed', listed)]
app = Starlette(routes=routes)
@app.route('/api/contact/{item_id:int}', methods=['PUT'])
async def update(request):
    return JSONResponse({'updated': True}, status_code=202)
`);
  const result=await scanProject({root});
  expect(result.project.operations.map(o=>[o.method,o.path])).toEqual(expect.arrayContaining([
   ['get','/listed'],['put','/api/contact/{item_id}']
  ]));
  const update=result.project.operations.find(o=>o.method==='put')!;
  expect(update.parameters?.[0]).toMatchObject({name:'item_id',schema:{type:'integer'}});
  expect(update.responses[0]?.statusCode).toBe('202');
  expect(update.responses[0]?.content?.[0]?.schema).toMatchObject({type:'object',properties:{updated:{type:'boolean'}},required:['updated']});
  expect((await result.convert()).documentValid).toBe(true);
 } finally { await rm(root,{recursive:true,force:true}); }
});
