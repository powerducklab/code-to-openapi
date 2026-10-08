import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('follows imported Pydantic input validation without mistaking unrelated models or mutated data for request schemas',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-input-model-'));
 try{
 await writeFile(join(root,'requirements.txt'),'flask\npydantic');
 await writeFile(join(root,'contracts.py'),`from pydantic import BaseModel,EmailStr
class Credentials(BaseModel):
    email: EmailStr
    secret: str
`);
 await writeFile(join(root,'app.py'),`from flask import Flask,request,jsonify
from contracts import Credentials as LoginInput
app=Flask(__name__)
@app.post('/sign-in')
def login():
    incoming=request.get_json()
    parsed=LoginInput(**incoming)
    return jsonify(ok=True)
@app.post('/unrelated')
def unrelated():
    incoming=request.get_json()
    parsed=LoginInput(**load_record())
    return jsonify(ok=True)
@app.post('/modified')
def modified():
    incoming=request.get_json()
    incoming['secret']='server-value'
    parsed=LoginInput(**incoming)
    return jsonify(ok=True)
`);
 const r=await scanProject({root,frameworks:['flask']});
 const op=(p:string)=>r.project.operations.find(o=>o.path===p)!;
 expect(op('/sign-in').requestBody?.content[0]?.schema).toMatchObject({properties:{email:{type:'string',format:'email'},secret:{type:'string'}},required:['email','secret']});
 expect(op('/sign-in').gaps).not.toContain('body-schema-unknown');
 for(const path of ['/unrelated','/modified'])expect(op(path).gaps).toContain('body-schema-unknown');
 expect((await r.convert({validate:true})).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true})}
});
