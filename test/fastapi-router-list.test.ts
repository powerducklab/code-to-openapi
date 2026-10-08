import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('resolves imported apps and tuple-mounted routers without mounting orphan routers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastapi-list-'));
 try {
  await writeFile(join(root,'requirements.txt'),'fastapi');
  await writeFile(join(root,'application.py'),'from fastapi import FastAPI\napp = FastAPI()\n');
  await writeFile(join(root,'routes.py'),`from fastapi import APIRouter
from pydantic import BaseModel
router = APIRouter(prefix="/users")
orphan = APIRouter()
class User(BaseModel):
    name: str
@router.post("/", response_model=User)
def create(body: User):
    return body
@orphan.get("/not-mounted")
def unused():
    return {}
`);
  await writeFile(join(root,'registry.py'),'from routes import router as user_router\nROUTERS = (user_router,)\n');
  await writeFile(join(root,'main.py'),`from application import app
from registry import ROUTERS as imported_routers
ROUTERS = (*imported_routers,)
for r in ROUTERS:
    app.include_router(r, prefix="/v1")
`);
  const {project}=await scanProject({root,frameworks:['fastapi']});
  expect(project.operations).toHaveLength(1);
  expect(project.operations[0]!.fullPath ?? project.operations[0]!.path).toBe('/v1/users/');
  expect(project.operations[0]!.requestBody).toBeDefined();
  expect(project.operations[0]!.gaps).not.toContain('body-schema-unknown');
 } finally {await rm(root,{recursive:true,force:true});}
});
