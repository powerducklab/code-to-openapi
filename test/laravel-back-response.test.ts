import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('resolves back redirects, explicit status codes and conditional flash-message chains',async()=>{
 const root=await mkdtemp(join(tmpdir(),'laravel-back-'));
 try {
  await mkdir(join(root,'routes'));
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^12.0'}}));
  await writeFile(join(root,'routes/web.php'),`<?php
use Illuminate\\Support\\Facades\\Route;
Route::post('/reset', function() { return $status ? back()->with('status', 'sent') : back()->withInput()->withErrors(['email'=>'failed']); });
Route::post('/return', function() { return back(303)->with('status', 'done'); });
Route::post('/bare', function() { return back(); });
Route::post('/moved', function() { return redirect('/home', 301)->with('status', 'done'); });
`);
  const result=await scanProject({root,frameworks:['laravel']});
  for(const [path,status] of [['/reset','302'],['/return','303'],['/bare','302'],['/moved','301']]) {
   const operation=result.project.operations.find(op=>op.path===path)!;
   expect(operation.responses.map(r=>r.statusCode)).toEqual([status]);
   expect(operation.responses[0].content).toBeUndefined();
   expect(operation.responses[0].headers?.Location).toMatchObject({type:'string'});
   expect(operation.gaps).not.toContain('response-unknown');
  }
 } finally {await rm(root,{recursive:true,force:true});}
});
