import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('uses declared PHP properties and leaves misleading untyped names unknown',async()=>{
 const root=await mkdtemp(join(tmpdir(),'php-property-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^11'}}));
  await writeFile(join(root,'routes.php'),`<?php
use Illuminate\\Support\\Facades\\Route;
class DTO { public string $id; public int $created_at; public string $price; }
Route::get('/typed',function(DTO $dto){return response()->json(['id'=>$dto->id,'created_at'=>$dto->created_at,'price'=>$dto->price]);});
Route::get('/unknown',function($opaque){return response()->json(['id'=>$opaque->id,'created_at'=>$opaque->created_at,'price'=>$opaque->price]);});
`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  expect(doc.paths['/typed'].get.responses['200'].content['application/json'].schema.properties).toEqual({id:{type:'string'},created_at:{type:'integer'},price:{type:'string'}});
  expect(doc.paths['/unknown'].get.responses['200'].content['application/json'].schema.properties).toEqual({id:{},created_at:{},price:{}});
  expect(result.project.operations.find(operation=>operation.path==='/unknown')?.gaps).toContain('response-schema-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('preserves Slim empty/trailing paths, strips nested regex constraints, and drops CORS catch-all',async()=>{
 const root=await mkdtemp(join(tmpdir(),'slim-path-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
  await writeFile(join(root,'routes.php'),`<?php
$app->group('/users',function($group){
 $group->get('',function($req,$res){return $res;});
 $group->get('/',function($req,$res){return $res;});
 $group->get('/{id:[0-9]{2}}',function($req,$res){return $res;});
});
$app->options('/{routes:.*}',function($req,$res){return $res;});
`);
  const result=await scanProject({root});const doc=(await result.convert()).document as any;
  expect(Object.keys(doc.paths).sort()).toEqual(['/users','/users/','/users/{id}']);
 }finally{await rm(root,{recursive:true,force:true});}
});
