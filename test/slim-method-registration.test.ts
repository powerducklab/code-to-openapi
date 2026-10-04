import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('preserves Slim any/map methods and empty group paths without inventing HEAD',async()=>{
 const root=await mkdtemp(join(tmpdir(),'slim-methods-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^4'}}));
  await writeFile(join(root,'app.php'),`<?php
$app->any('/any', function($request,$response){return $response->withStatus(204);});
$app->map(['GET','POST','GET'], '/mapped', function($request,$response){return $response->withStatus(202);});
$app->map(['GET',$dynamic], '/partial', $handler);
$app->get($dynamicPath, $handler);
$app->group('/v1', function($group){
 $group->group('/users', function($r){
  $r->get('', $handler);
  $r->get('/', $handler);
  $r->get('/{id:[0-9]{2}}', $handler);
 });
});
class CallableAction {public function __invoke($req,$res){return $res->withStatus(201);} public function other($req,$res){return $res->withStatus(202);}}
$app->get('/array-handler', [CallableAction::class,'other']);
`);
  const result=await scanProject({root});const ops=result.project.operations;
  expect(ops.filter(op=>op.path==='/any').map(op=>op.method).sort()).toEqual(['delete','get','options','patch','post','put']);
  expect(ops.filter(op=>op.path==='/mapped').map(op=>op.method).sort()).toEqual(['get','post']);
  expect(ops.filter(op=>op.path?.startsWith('/v1')).map(op=>op.path).sort()).toEqual(['/v1/users','/v1/users/','/v1/users/{id}']);
  expect(ops.find(op=>op.path==='/array-handler')?.responses.some(response=>response.statusCode==='201')).toBe(false);
  expect(result.project.unresolved.some(item=>item.reason==='dynamic-methods')).toBe(true);
  expect(result.project.unresolved.some(item=>item.reason==='dynamic-path')).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
