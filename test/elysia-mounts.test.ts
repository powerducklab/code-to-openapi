import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('preserves constructor, factory, group and repeated plugin mount paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'elysia-mounts-'));
 try {
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{elysia:'*'}}));
 await writeFile(join(root,'child.ts'),`import {Elysia} from 'elysia';
export function setup(){return new Elysia({prefix:'/v1'}).get('/item',()=>({ok:true}));}`);
 await writeFile(join(root,'barrel.ts'),`export {setup} from './child';`);
 await writeFile(join(root,'app.ts'),`import {Elysia} from 'elysia';import {setup} from './barrel';
const child=setup();const app=new Elysia({prefix:'/api'}).group('/a',a=>a.use(child)).group('/b',b=>b.use(child));
app.use(app);
class Fake {get(...args:any[]){} }; const fake=new Fake();fake.get('/fake',()=>{});`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 expect(Object.keys((converted.document as any).paths).sort()).toEqual(['/api/a/v1/item','/api/b/v1/item']);
 expect(result.project.unresolved.some(u=>u.message.includes('Cyclic Elysia'))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
