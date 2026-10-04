import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('keeps native nullable/required/length semantics and query rules; ignores unrelated helper arrays',async()=>{
 const root=await mkdtemp(join(tmpdir(),'laravel-rules-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^13'}}));
  await writeFile(join(root,'routes.php'),`<?php
   use Illuminate\\Support\\Facades\\Route;
   use Illuminate\\Foundation\\Http\\FormRequest;
   class ParentRequest extends FormRequest {public function rules():array {
    log_message(['not_a_field'=>'required']);
    return ['prompt'=>['required','string','max:500'],'folder'=>['nullable','string'],'mode'=>'sometimes|required|string|in:UP,DOWN'];
   }}
   class ChildRequest extends ParentRequest {}
   class DynamicRequest extends FormRequest {public function rules():array {
    log_message(['phantom'=>'required']);return $this->customRules();
   }}
   Route::get('/search',fn(ChildRequest $request)=>response()->json([]));
   Route::post('/prompt',fn(ChildRequest $request)=>response()->json([]));
   Route::post('/dynamic',fn(DynamicRequest $request)=>response()->json([]));
  `);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  const body=doc.paths['/prompt'].post.requestBody.content['application/json'].schema;
  expect(body.required).toEqual(['prompt']);
  expect(body.properties).toEqual({prompt:{type:'string',minLength:1,maxLength:500},folder:{type:['string','null']},mode:{type:'string',minLength:1,enum:['UP','DOWN']}});
  expect(doc.paths['/search'].get.requestBody).toBeUndefined();
  expect(doc.paths['/search'].get.parameters.map((p:any)=>[p.name,!!p.required])).toEqual([['prompt',true],['folder',false],['mode',false]]);
  expect(result.project.operations.find(o=>o.path==='/dynamic')?.gaps).toContain('body-schema-unknown');
  expect(doc.paths['/dynamic'].post.requestBody).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
