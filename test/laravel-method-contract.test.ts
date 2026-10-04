import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';

it('preserves Laravel match/any verbs without inventing GET for dynamic methods',async()=>{
 const root=await mkdtemp(join(tmpdir(),'laravel-verbs-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^13'}}));
  await writeFile(join(root,'routes.php'),`<?php
   use Illuminate\\Support\\Facades\\Route;
   Route::match(['POST','OPTIONS'], '/match', fn()=>response()->json(['ok'=>true]));
   Route::any('/any', fn()=>response()->json(['ok'=>true]));
   Route::match($configuredMethods, '/dynamic', fn()=>response()->json(['ok'=>true]));
   class AlbumController {public function index(){return response()->json([]);}}
   Route::apiResource('albums', AlbumController::class);
  `);
  const result=await scanProject({root});
  const verbs=(path:string)=>result.project.operations.filter(o=>o.path===path).map(o=>o.method).sort();
  expect(verbs('/match')).toEqual(['options','post']);
  expect(verbs('/any')).toEqual(['delete','get','head','options','patch','post','put']);
  expect(verbs('/dynamic')).toEqual([]);
  expect(result.project.unresolved).toContainEqual(expect.objectContaining({reason:'dynamic-methods'}));
  expect(verbs('/albums')).toEqual(['get','post']);
  expect(result.project.operations.find(o=>o.path==='/albums'&&o.method==='post')?.gaps).toContain('response-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
