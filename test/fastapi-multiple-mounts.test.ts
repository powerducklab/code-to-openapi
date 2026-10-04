import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('retains every router mount and stops cyclic registrations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastapi-mounts-'));
 try{
 await writeFile(join(root,'app.py'),`from fastapi import FastAPI, APIRouter
app=FastAPI()
router=APIRouter()
@router.get('/items')
def items():
    return {'ok': True}
app.include_router(router,prefix='/v1')
app.include_router(router,prefix='/v2')
router.include_router(router,prefix='/loop')
`);
 const result=await scanProject({root});
 expect(result.project.operations.map(o=>o.path).sort()).toEqual(['/v1/items','/v2/items']);
 expect(result.project.unresolved.some(u=>u.message.includes('Cyclic'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('uses settings defaults conservatively without reading unrelated function locals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastapi-prefix-scope-'));
 try {
 await writeFile(join(root,'app.py'),`from fastapi import FastAPI, APIRouter
from pydantic import BaseModel
class Settings(BaseModel):
    api_prefix: str = '/api'
def get_settings() -> Settings:
    return Settings()
def unrelated():
    prefix = '/wrong'
settings = get_settings()
app = FastAPI()
router = APIRouter()
@router.get('/items')
def items():
    return {'ok': True}
app.include_router(router, prefix=settings.api_prefix)
app.include_router(router, prefix=prefix)
`);
 const result=await scanProject({root});
 const paths=result.project.operations.map(o=>o.path);
 expect(paths).toContain('/api/items');
 expect(paths).not.toContain('/wrong/items');
 expect(result.project.unresolved.some(u=>u.reason==='path-dynamic')).toBe(true);
 } finally {await rm(root,{recursive:true,force:true});}
});
