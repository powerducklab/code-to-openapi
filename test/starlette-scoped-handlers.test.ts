import {expect,it} from 'vitest';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('resolves imported and local endpoint names without using unrelated same-named functions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'starlette-scopes-'));
 try{
  await mkdir(join(root,'api'));
  await writeFile(join(root,'api/__init__.py'),'');
  await writeFile(join(root,'api/handlers.py'),`from starlette.responses import JSONResponse
async def get(request):
    return JSONResponse({'remote':True}, status_code=202)
`);
  await writeFile(join(root,'unrelated.py'),`from starlette.responses import JSONResponse
async def get(request):
    return JSONResponse({'wrong':True}, status_code=418)
`);
  await writeFile(join(root,'api/app.py'),`from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import JSONResponse
from .handlers import get as remote
from . import handlers as h
import api.handlers
async def get(request):
    return JSONResponse({'local':True}, status_code=201)
app=Starlette(routes=[Route('/local',get),Route('/remote',remote),Route('/module',h.get),Route('/absolute',api.handlers.get)])
`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  expect(Object.keys(doc.paths['/local'].get.responses)).toEqual(['201']);
  for(const path of ['/remote','/module','/absolute']){
   expect(Object.keys(doc.paths[path].get.responses)).toEqual(['202']);
   expect(doc.paths[path].get.responses['202'].content['application/json'].schema.properties).toEqual({remote:{type:'boolean'}});
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

it('keeps imported same-named mounted apps separate and bounds recursive mount expansion',async()=>{
 const root=await mkdtemp(join(tmpdir(),'starlette-mounts-'));
 try{
  for(const [file,status] of [['one',201],['two',202]] as const){
   await writeFile(join(root,`${file}.py`),`from starlette.applications import Starlette
from starlette.routing import Route
from starlette.responses import JSONResponse
async def endpoint(request):
    return JSONResponse({'ok':True},status_code=${status})
app=Starlette(routes=[Route('/item',endpoint)])
`);
  }
  await writeFile(join(root,'app.py'),`from starlette.applications import Starlette
from starlette.routing import Mount
from one import app as first
from two import app as second
app=Starlette(routes=[Mount('/one',app=first),Mount('/two',app=second)])
`);
  let result=await scanProject({root});let doc=(await result.convert()).document as any;
  expect(Object.keys(doc.paths).sort()).toEqual(['/one/item','/two/item']);
  expect(Object.keys(doc.paths['/one/item'].get.responses)).toEqual(['201']);
  expect(Object.keys(doc.paths['/two/item'].get.responses)).toEqual(['202']);
  // Invalid/in-progress source still must terminate; never recursively expand forever.
  await writeFile(join(root,'cycle.py'),`from starlette.applications import Starlette
from starlette.routing import Mount
child=Starlette(routes=[Mount('/again',app=child)])
root=Starlette(routes=[Mount('/cycle',app=child)])
`);
  result=await scanProject({root});
  expect(JSON.stringify(result.project)).toContain('Recursive Starlette mount');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('resolves imported route-list aliases and ignores uncalled local list shadowing', async () => {
 const root=await mkdtemp(join(tmpdir(),'starlette-route-lists-'));
 try {
  await writeFile(join(root,'routes.py'),`from starlette.routing import Route
from starlette.responses import JSONResponse
async def endpoint(request):
    return JSONResponse({'actual': True})
routes = [Route('/actual', endpoint)]
exported = routes
`);
  await writeFile(join(root,'app.py'),`from starlette.applications import Starlette
from starlette.routing import Route
from routes import exported as imported_routes
import routes as routing

def unused():
    imported_routes = [Route('/wrong', None)]
    ghost = Starlette(routes=[Route('/ghost', None)])

app = Starlette(routes=imported_routes)
other = Starlette(routes=routing.exported)
`);
  const result=await scanProject({root});
  const converted=await result.convert();
  expect(converted.documentValid).toBe(true);
  expect(Object.keys((converted.document as any).paths)).toEqual(['/actual']);
  expect((converted.document as any).paths['/actual'].get.responses['200'].content['application/json'].schema.properties).toEqual({actual:{type:'boolean'}});
 } finally {await rm(root,{recursive:true,force:true});}
});

it('reports dynamic mount prefixes and ambiguous route lists without inventing root routes', async () => {
 const root=await mkdtemp(join(tmpdir(),'starlette-dynamic-mounts-'));
 try {
  await writeFile(join(root,'app.py'),`import os
from starlette.applications import Starlette
from starlette.routing import Mount, Route
from starlette.responses import JSONResponse
async def endpoint(request):
    return JSONResponse({'ok':True})
app = Starlette(routes=[Mount(os.getenv('PREFIX'), routes=[Route('/child',endpoint)])])
routes = [Route('/before',endpoint)]
routes = [Route('/after',endpoint)]
ambiguous = Starlette(routes=routes)
`);
  const result=await scanProject({root});
  expect(result.project.operations).toHaveLength(0);
  expect(JSON.stringify(result.project)).toContain('Starlette mount prefix');
  expect(JSON.stringify(result.project)).toContain('Starlette route list cannot');
 } finally {await rm(root,{recursive:true,force:true});}
});
