import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject,buildGapMessages,gapCacheKey} from '../src/index.js';
it('includes PHP aliased dependencies and their local dependencies; keeps external evidence visibly unavailable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-source-'));
 try {
  await mkdir(join(root,'routes'));
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^12.0'}}));
  await writeFile(join(root,'routes/web.php'),`<?php use Illuminate\\Support\\Facades\\Route; use App\\Entry; Route::post('/feed',[Entry::class,'store']);`);
  await writeFile(join(root,'Entry.php'),`<?php namespace App; use App\\Payload as Input; use HotwiredLaravel\\TurboLaravel\\Http\\MultiplePendingTurboStreamResponse as Stream; class Entry { public function store(Input $request): Stream { return response()->turboStream([]); } }`);
  await writeFile(join(root,'Payload.php'),`<?php namespace App; use App\\Nested; class Payload { public function rules() { return ['title'=>'required|string']; } }`);
  await writeFile(join(root,'Nested.php'),`<?php namespace App; class Nested { public string $value; }`);
  const result=await scanProject({root,aiReview:'manual',reviewAll:true});
  const operation=result.project.operations.find(op=>op.path==='/feed')!;
  expect(operation.responses).toMatchObject([{statusCode:'200',content:[{mediaType:'text/vnd.turbo-stream.html',schema:{type:'string'}}]}]);
  expect(operation.gaps).not.toContain('response-unknown');
  const request=result.gapReviews![0]!.request;
  expect(request.sourceContext?.files.map(f=>f.file)).toEqual(expect.arrayContaining(['Entry.php','Payload.php','Nested.php']));
  expect(request.sourceContext?.unavailable).toContain('HotwiredLaravel\\TurboLaravel\\Http\\MultiplePendingTurboStreamResponse');
  expect(buildGapMessages(request)[1]!.content).toContain('required|string');
  expect(gapCacheKey(request,'v')).not.toEqual(gapCacheKey({...request,sourceContext:{...request.sourceContext!,files:[]}},'v'));
 }finally{await rm(root,{recursive:true,force:true});}
});
it('follows TypeScript relative imports across files with a bounded source budget',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-ts-source-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.ts'),`import express from 'express'; import { handler } from './handler'; const app=express(); app.get('/value',handler);`);
  await writeFile(join(root,'handler.ts'),`import {lookup} from './service'; export function handler(req:any,res:any){res.json(lookup());}`);
  await writeFile(join(root,'service.ts'),`import {Thing} from './model'; export function lookup(){return new Thing();}`);
  await writeFile(join(root,'model.ts'),`export class Thing { title='value'; }`);
  const result=await scanProject({root,aiReview:'manual',reviewAll:true});
  const request=result.gapReviews![0]!.request;
  expect(request.sourceContext?.files.map(f=>f.file)).toEqual(expect.arrayContaining(['handler.ts','service.ts','model.ts']));
  expect(request.sourceContext!.files.reduce((n,f)=>n+f.source.length,0)).toBeLessThanOrEqual(24000);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('keeps late handlers visible and follows dependency chains beyond two hops without looping',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-deep-source-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.ts'),`import express from 'express'; import {handler} from './handler'; const app=express();app.get('/deep',handler);`);
  await writeFile(join(root,'handler.ts'),`import {lookup} from './a';\n${'// filler\n'.repeat(1000)}export function handler(req:any,res:any){res.json(lookup());}`);
  await writeFile(join(root,'a.ts'),`import {b} from './b';export function lookup(){return b();}`);
  await writeFile(join(root,'b.ts'),`import {c} from './c';export function b(){return c();}`);
  await writeFile(join(root,'c.ts'),`import {lookup} from './a';export function c(){return {deepEvidence:'present'};}`);
  const result=await scanProject({root,aiReview:'manual',reviewAll:true});
  const context=result.gapReviews![0]!.request.sourceContext!;
  expect(context.files.find(f=>f.file==='handler.ts')?.source).toContain('res.json(lookup())');
  expect(context.files.find(f=>f.file==='c.ts')?.source).toContain('deepEvidence');
  expect(new Set(context.files.map(f=>f.file)).size).toBe(context.files.length);
  expect(context.truncated).toBe(true);
  expect(context.files.reduce((n,f)=>n+f.source.length,0)).toBeLessThanOrEqual(24000);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('follows indexed PHP includes and function imports, while exposing dynamic includes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-php-include-'));
 try {
  await mkdir(join(root,'routes'));
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^12.0'}}));
  await writeFile(join(root,'routes/web.php'),`<?php use Illuminate\\Support\\Facades\\Route; use App\\Entry; Route::post('/include',[Entry::class,'store']);`);
  await writeFile(join(root,'Entry.php'),`<?php namespace App; require_once __DIR__ . '/service.php'; use function App\\formatOutput; class Entry { public function store() { require $runtimeFile; return formatOutput(fetchValue()); } }`);
  await writeFile(join(root,'service.php'),`<?php namespace App; function fetchValue() { return ['id'=>1]; }`);
  await writeFile(join(root,'formatter.php'),`<?php namespace App; function formatOutput($value) { return response()->json($value); }`);
  const result=await scanProject({root,aiReview:'manual',reviewAll:true});
  const context=result.gapReviews![0]!.request.sourceContext!;
  expect(context.files.map(f=>f.file)).toEqual(expect.arrayContaining(['service.php','formatter.php']));
  expect(context.unavailable).toContain('dynamic PHP include: Entry.php');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('follows static dynamic imports but reports computed imports instead of guessing a module',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-js-import-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.ts'),`import express from 'express'; const app=express(); app.get('/value',async(req,res)=>{const service=await import('./service');await import(req.query.module);res.json(service.load());});`);
  await writeFile(join(root,'service.ts'),`export function load(){return {id:'value'};}`);
  const result=await scanProject({root,aiReview:'manual',reviewAll:true});
  const context=result.gapReviews![0]!.request.sourceContext!;
  expect(context.files.map(f=>f.file)).toContain('service.ts');
  expect(context.unavailable).toContain('dynamic module dependency in app.ts');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('selects imports used through local helpers without spending context on another route',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-focused-import-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.ts'),`import express from 'express';import {load} from './service';import {unrelated} from './unrelated';const app=express();function helper(){return load();}app.get('/focused',(req,res)=>res.json(helper()));app.get('/other',(req,res)=>res.json(unrelated()));`);
  await writeFile(join(root,'service.ts'),`export function load(){return {id:'value'};}`);
  await writeFile(join(root,'unrelated.ts'),`export function unrelated(){return {unrelated:true};}`);
  const result=await scanProject({root,aiReview:'manual',reviewAll:true});
  const context=result.gapReviews!.find(q=>q.path==='/focused')!.request.sourceContext!;
  expect(context.files.map(f=>f.file)).toContain('service.ts');
  expect(context.files.map(f=>f.file)).not.toContain('unrelated.ts');
 }finally{await rm(root,{recursive:true,force:true});}
});
