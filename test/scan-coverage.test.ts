import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {scanProject} from '../src/index.js';
import {indexProject} from '../src/core/indexer.js';
import {expressPack} from '../src/frameworks/express.js';

it('reports skipped source files including explicit source roots without flagging intentional ignores',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scan-coverage-'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
  await writeFile(join(root,'app.js'),`const express=require('express');const app=express();app.get('/ok',(req,res)=>res.json({ok:true}));`);
  await writeFile(join(root,'large.js'),' '.repeat(300));
  await writeFile(join(root,'binary.py'),'x\u0000x');
  await writeFile(join(root,'.gitignore'),'ignored.js\ndist/\n');
  await writeFile(join(root,'ignored.js'),' '.repeat(300));
  await mkdir(join(root,'dist'));
  await writeFile(join(root,'dist','generated.js'),' '.repeat(300));
  const r=await scanProject({root,maxFileBytes:200,additionalSourceRoots:['dist']});
  expect(r.project.operations.some(o=>o.path==='/ok')).toBe(true);
  const issues=r.project.unresolved??[];
  expect(issues.filter(i=>i.reason==='source-skipped').map(i=>i.origin?.file).sort()).toEqual(['binary.py','dist/generated.js','large.js']);
  expect(r.report.unresolved).toBe(3);
  expect(r.report.diagnostics.join('\n')).toContain('large.js');
  expect((await r.convert({validate:true})).documentValid).toBe(true);
  for(const value of [0,-1,NaN,Infinity,1.5])expect(()=>indexProject(root,{maxFileBytes:value})).toThrow('positive safe integer');
  await rm(join(root,'app.js'));
  await expect(scanProject({root,maxFileBytes:200})).rejects.toThrow('No scannable source files remain:');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('preserves successful framework results while marking a failed extraction as incomplete',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scan-pack-failure-'));
 const spy=vi.spyOn(expressPack,'extract').mockRejectedValue(new Error('injected failure'));
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*',fastify:'*'}}));
  await writeFile(join(root,'app.js'),`const app=require('fastify')();app.get('/alive',async()=>({ok:true}));`);
  const r=await scanProject({root,frameworks:['express','fastify']});
  expect(r.project.operations.some(o=>o.path==='/alive')).toBe(true);
  expect(r.project.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({reason:'extraction-failed'})]));
  expect(r.report.diagnostics.join('\n')).toContain('injected failure');
 }finally{spy.mockRestore();await rm(root,{recursive:true,force:true});}
});

it('fails explicitly on file and total-byte budgets, including combined additional roots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scan-budget-'));
 try {
  await writeFile(join(root,'a.js'),'// one');
  await writeFile(join(root,'b.js'),'// two');
  expect(()=>indexProject(root,{maxFiles:1})).toThrow('Source file limit exceeded');
  expect(()=>indexProject(root,{maxTotalBytes:10})).toThrow('Source byte limit exceeded');
  expect(indexProject(root,{maxFiles:2,maxTotalBytes:12}).files).toHaveLength(2);
  await mkdir(join(root,'dist'));
  await writeFile(join(root,'.gitignore'),'dist/');
  await writeFile(join(root,'dist','c.js'),'// three');
  await expect(scanProject({root,maxFiles:2,additionalSourceRoots:['dist']})).rejects.toThrow('across additional source roots');
  await expect(scanProject({root,maxTotalBytes:16,additionalSourceRoots:['dist']})).rejects.toThrow('across additional source roots');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('decodes BOM-marked UTF-16 source files without accepting binary or truncated text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scan-encoding-'));
 try {
  const source=`export const title = "世界";`;
  const encoded=Buffer.from(source,'utf16le');
  await writeFile(join(root,'little.ts'),Buffer.concat([Buffer.from([0xff,0xfe]),encoded]));
  await writeFile(join(root,'big.ts'),Buffer.concat([Buffer.from([0xfe,0xff]),Buffer.from(encoded).swap16()]));
  await writeFile(join(root,'truncated.ts'),Buffer.from([0xff,0xfe,0x61]));
  const index=indexProject(root);
  expect(index.files).toHaveLength(2);
  for(const file of index.files)expect(file.content).toBe(source);
  expect(index.unresolved?.[0]?.origin?.file).toBe('truncated.ts');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('preserves successful framework results while marking a failed detection as incomplete',async()=>{
 const root=await mkdtemp(join(tmpdir(),'scan-pack-failure-'));
 const spy=vi.spyOn(expressPack,'applies').mockImplementation(()=>{throw new Error('injected failure')});
 try{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*',fastify:'*'}}));
  await writeFile(join(root,'app.js'),`const app=require('fastify')();app.get('/alive',async()=>({ok:true}));`);
  const r=await scanProject({root,frameworks:['express','fastify']});
  expect(r.project.operations.some(o=>o.path==='/alive')).toBe(true);
  expect(r.project.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({reason:'extraction-failed'})]));
  expect(r.report.diagnostics.join('\n')).toContain('injected failure');
 }finally{spy.mockRestore();await rm(root,{recursive:true,force:true});}
});
