import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('follows controller helpers through HTML and redirect branches without serializing template variables',async()=>{
 const root=await mkdtemp(join(tmpdir(),'laravel-delegated-'));
 try{
  await mkdir(join(root,'routes'));
  await writeFile(join(root,'composer.json'),JSON.stringify({require:{'laravel/framework':'^12.0'}}));
  await writeFile(join(root,'routes/web.php'),`<?php
use Illuminate\\Support\\Facades\\Route;
use App\\InvitationController;
Route::get('/invitations/{token}',[InvitationController::class,'show'])->where('token', '[A-Za-z0-9]{40}');
Route::post('/invitations/{token}',[InvitationController::class,'store']);
Route::get('/cycle',[InvitationController::class,'cycle']);
`);
  await writeFile(join(root,'Controller.php'),`<?php
namespace App;
class InvitationController {
 public function show($token) {return $this->render();}
 public function store($token) {if ($token) return $this->render(); return $this->goHome();}
 private function render() {if (rand()) return view('invite',['state'=>'ready']); return $this->goHome();}
 private function goHome() {return redirect('/home');}
 public function cycle() {return $this->cycle();}
}
`);
  const result=await scanProject({root,frameworks:['laravel']});
  for(const op of result.project.operations.filter(op=>op.path==='/invitations/{token}')){
   expect(op.responses.map(r=>r.statusCode).sort()).toEqual(['200','302']);
   expect(op.responses.find(r=>r.statusCode==='200')?.content).toEqual(expect.arrayContaining([expect.objectContaining({mediaType:'text/html',schema:{type:'string'}})]));
   expect(op.responses.some(r=>r.content?.some(c=>c.mediaType==='application/json'))).toBe(false);
   expect(op.gaps).not.toContain('response-unknown');
  }
  expect(result.project.operations.filter(op=>op.path==='/invitations/{token}')).toHaveLength(2);
  expect(result.project.operations.find(op=>op.method==='get' && op.path==='/invitations/{token}')?.parameters.find(p=>p.name==='token')?.schema).toMatchObject({pattern:'^(?:[A-Za-z0-9]{40})$'});
  expect(result.project.operations.find(op=>op.method==='get' && op.path==='/invitations/{token}')?.responses.find(r=>r.statusCode==='302')?.headers?.Location).toEqual({type:'string',format:'uri-reference'});
  expect(result.project.operations.find(op=>op.path==='/cycle')?.gaps).toContain('response-unknown');
  expect((await result.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
