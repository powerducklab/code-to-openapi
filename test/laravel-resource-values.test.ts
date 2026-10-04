import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('preserves literal keys, both conditional types, and unknown computed values',async()=>{
 const root=await mkdtemp(join(tmpdir(),'laravel-values-'));
 try{
 await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^11'}}));
 await writeFile(join(root,'routes.php'),`<?php
use Illuminate\\Support\\Facades\\Route;
use Illuminate\\Http\\Resources\\Json\\JsonResource;
class ResultResource extends JsonResource {
 public function toArray($request){return ['static'=>'ok','computed'=>$this->opaque(),'variant'=>$this->enabled ? 1 : 'no'];}
}
Route::get('/result',function(){return new ResultResource();});`);
 const result=await scanProject({root});const converted=await result.convert();expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.components.schemas.ResultResource.properties).toEqual({static:{type:'string'},computed:{},variant:{type:['integer','string']}});
 expect(result.project.operations[0]?.gaps).toContain('response-schema-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
