import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('separates input, serialized output and response exclusion policies through nested refs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'fastapi-direction-'));
 try{
 await writeFile(join(root,'app.py'),`from fastapi import FastAPI, Body
from pydantic import BaseModel, Field
from typing import Optional
app=FastAPI()
class User(BaseModel):
    display_name: str = Field(..., alias='displayName')
    age: Optional[int] = None
class Envelope(BaseModel):
    user: User
@app.post('/users',response_model=Envelope)
def create(payload: Envelope = Body(...,embed=True,alias='data')):
    return payload
@app.get('/partial',response_model=User,response_model_exclude_unset=True)
def partial():
    return {'displayName':'Ada'}
@app.get('/plain',response_model=User,response_model_by_alias=False)
def plain():
    return {'displayName':'Ada'}
`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);const doc=converted.document as any;
 const models=doc.components.schemas;
 expect(models.User.required).toEqual(['displayName','age']);
 expect(models.User.properties.age.type).toEqual(['integer','null']);
 expect(models.input_User.required).toEqual(['displayName']);
 expect(models.input_Envelope.properties.user.$ref).toBe('#/components/schemas/input_User');
 expect(models.Envelope.properties.user.$ref).toBe('#/components/schemas/User');
 const body=doc.paths['/users'].post.requestBody;
 expect(body.required).toBe(true);expect(body.content['application/json'].schema.properties.data.$ref).toBe('#/components/schemas/input_Envelope');
 const resolve=(path:string)=>models[doc.paths[path].get.responses['200'].content['application/json'].schema.$ref.split('/').pop()];
 expect(resolve('/partial').required).toEqual(['displayName']);
 expect(resolve('/plain').properties.display_name.type).toBe('string');
 expect(resolve('/plain').properties.displayName).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
