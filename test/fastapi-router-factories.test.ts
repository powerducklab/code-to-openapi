import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('resolves imported static router factories without mixing local bindings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastapi-factory-'));
 try{
  await writeFile(join(root,'routers.py'),`from fastapi import APIRouter

def make_users():
    router = APIRouter(prefix="/users")
    @router.get("/list")
    def users():
        return {"ok": True}
    return router

def make_admin():
    router = APIRouter(prefix="/admin")
    @router.post("/add")
    def add():
        return {"ok": True}
    return router

def conditional():
    router = APIRouter()
    if enabled:
        return router

def recursive():
    return recursive()
`);
  await writeFile(join(root,'main.py'),`from fastapi import FastAPI, APIRouter
from routers import make_users as users, make_admin, recursive, conditional
app = FastAPI()
app.include_router(users(), prefix="/v1")
app.include_router(make_admin(), prefix="/v2")
app.include_router(recursive())
app.include_router(conditional())
`);
  const r=await scanProject({root});
  const paths=r.project.operations.map(op=>op.path);
  expect(paths).toContain('/v1/users/list');expect(paths).toContain('/v2/admin/add');
  expect(paths).not.toContain('/v1/admin/list');expect(paths).not.toContain('/v2/users/add');
  expect(r.project.unresolved.some(u=>u.message?.includes('recursive()'))).toBe(true);
  expect(r.project.unresolved.some(u=>u.message?.includes('conditional()'))).toBe(true);
  expect((await r.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
