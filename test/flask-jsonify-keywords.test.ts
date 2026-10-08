import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('reads Flask JSON keyword fields and heterogeneous positional values without filling dynamic fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'flask-jsonify-'));
 try{
  await writeFile(join(root,'requirements.txt'),'flask');
  await writeFile(join(root,'app.py'),`from flask import Flask,jsonify
app=Flask(__name__)
@app.get('/finished')
def finished(): return jsonify(message='Done',count=2,active=True),202
@app.get('/partial')
def partial(): return jsonify(message='Done',token=make_token())
@app.get('/sequence')
def sequence(): return jsonify('value',2)
@app.get('/expanded')
def expanded(): return jsonify(**load_fields())
@app.get('/mixed')
def mixed(): return [{'id':1},{'label':'second'}]
@app.get('/empty')
def empty(): return jsonify()
`);
  const r=await scanProject({root,frameworks:['flask']});
  const op=(path:string)=>r.project.operations.find(o=>o.path===path)!;
  expect(op('/finished').responses[0]).toMatchObject({statusCode:'202',content:[{schema:{type:'object',required:['message','count','active'],properties:{message:{type:'string'},count:{type:'integer'},active:{type:'boolean'}}}}]});
  expect(op('/finished').gaps).toEqual([]);
  expect(op('/partial').responses[0]?.content?.[0]?.schema).toMatchObject({properties:{message:{type:'string'},token:{}}});
  expect(op('/partial').gaps).toContain('response-schema-unknown');
  expect(op('/expanded').gaps).toContain('response-schema-unknown');
  expect(op('/sequence').responses[0]?.content?.[0]?.schema).toMatchObject({type:'array',items:{anyOf:[{type:'string'},{type:'integer'}]}});
  expect(op('/mixed').responses[0]?.content?.[0]?.schema).toMatchObject({type:'array',items:{anyOf:[{properties:{id:{type:'integer'}}},{properties:{label:{type:'string'}}}]}});
  expect(op('/empty').responses[0]?.content?.[0]?.schema).toEqual({type:'null'});
 }finally{await rm(root,{recursive:true,force:true})}
});
