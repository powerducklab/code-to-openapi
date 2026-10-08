import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('extracts double-quoted Slim paths but never truncates interpolated paths or prefixes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'slim-quotes-'));
 try{
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'slim/slim':'^3'}}));
  await writeFile(join(root,'app.php'),`<?php
$app = new \\Slim\\App;
$app->group("/api", function() use ($app) {
 $app->get("/ping",function($req,$res){return $res->withJson(['ok'=>true]);});
 $app->get("/user/$id",function($req,$res){return $res;});
});
$app->group("/$tenant",function() use ($app){$app->get('/secret',function($req,$res){return $res;});});`);
  const r=await scanProject({root});
  expect(r.project.operations.map(o=>o.fullPath??o.path)).toEqual(['/api/ping']);
  expect(r.project.unresolved?.filter(x=>x.reason==='dynamic-path')).toHaveLength(2);
  expect((await r.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
