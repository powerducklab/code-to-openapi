import {mkdtemp,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('detects direct DRF imports without a root requirements manifest',async()=>{
 const root=await mkdtemp(join(tmpdir(),'drf-imports-'));
 try{
  await cp(join(__dirname,'fixtures/drf-py'),root,{recursive:true});
  await rm(join(root,'requirements.txt'));
  const r=await scanProject({root,includeTests:true});
  expect(r.report.frameworks).toContain('drf');
  expect(r.project.operations.some(o=>(o.fullPath??o.path)==='/api/articles/')).toBe(true);
  expect((await r.convert()).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
