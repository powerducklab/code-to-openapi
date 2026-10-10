import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scanProject} from '../src/index.js';
it('scans extended Express methods and converts to additionalOperations',async()=>{
 const root=await mkdtemp(join(tmpdir(),'express-methods-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'4'}}));
  await writeFile(join(root,'app.js'),`const express=require('express');const app=express();app.propfind('/files',(req,res)=>res.json({ok:true}));app.trace('/echo',(req,res)=>res.send('ok'));`);
  const scan=await scanProject({root});
  expect(scan.project.operations.map(op=>op.method)).toEqual(expect.arrayContaining(['propfind','trace']));
  const converted=await scan.convert();
  expect((converted.document as any).paths['/files'].additionalOperations.PROPFIND).toBeDefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
it('recognizes Go ServeMux custom method tokens',async()=>{
 const root=await mkdtemp(join(tmpdir(),'go-methods-'));
 try{
  await writeFile(join(root,'go.mod'),'module sample\n\ngo 1.22\n');
  await writeFile(join(root,'main.go'),`package main\nimport "net/http"\nfunc main(){http.HandleFunc("CUSTOM-VERB /files",func(w http.ResponseWriter,r *http.Request){w.Write([]byte("ok"))})}`);
  const scan=await scanProject({root});
  expect(scan.project.operations.some(op=>op.method==='custom-verb'&&op.path==='/files')).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
