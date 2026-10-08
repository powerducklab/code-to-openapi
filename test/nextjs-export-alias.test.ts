import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('preserves factory-backed verb aliases without inventing the external handler contract',async()=>{
 const root=await mkdtemp(join(tmpdir(),'next-alias-'));
 try {
  await mkdir(join(root,'app/api/auth/[...auth]'),{recursive:true});
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{next:'14','next-auth':'4'}}));
  await writeFile(join(root,'app/api/auth/[...auth]/route.ts'),`import NextAuth from 'next-auth/next';
const handler=NextAuth({});
export {handler as GET,handler as POST};
`);
  const result=await scanProject({root,frameworks:['nextjs']});
  expect(result.project.operations.map(op=>op.method).sort()).toEqual(['get','post']);
  for(const op of result.project.operations){
   expect(op.path).toBe('/api/auth/{auth}');
   expect(op.parameters.some(p=>p.in==='path'&&p.name==='auth')).toBe(true);
   expect(op.gaps).toContain('response-unknown');
  }
  expect(result.project.operations.find(op=>op.method==='post')!.gaps).toContain('body-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
