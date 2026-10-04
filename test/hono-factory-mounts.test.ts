import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('resolves overloaded barrel-exported factories, chained mounts and repeated mounts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hono-factories-'));
 try {
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{hono:'*','@hono/zod-openapi':'*'}}));
 await writeFile(join(root,'tsconfig.json'),JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@/*':['./*']}}}));
 await writeFile(join(root,'factory.ts'),`import {OpenAPIHono} from '@hono/zod-openapi';
export function createApp(options?:object): OpenAPIHono;
export function createApp(options?:object){const app=new OpenAPIHono();return app;}`);
 await writeFile(join(root,'barrel.ts'),`export {createApp} from './factory';`);
 await writeFile(join(root,'child.ts'),`import {createApp} from '@/barrel';
import {createRoute,z} from '@hono/zod-openapi';
const child=createApp();
const route=createRoute({method:'post',path:'/item',request:{body:{content:{'application/json':{schema:z.object({name:z.string()})}}}},responses:{200:{description:'ok'}}});
child.openapi(route,c=>c.json({ok:true}));
export const group=createApp().route('/a',child).route('/b',child);`);
 await writeFile(join(root,'app.ts'),`import {createApp} from '@/barrel';import {group} from '@/child';
const app=createApp();app.route('/api',group);app.route('/cycle',app);
function notAnApp(){return {get(){}}};const fake=notAnApp();fake.get('/fake',()=>{});`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 expect(result.project.unresolved.some(u=>u.message.includes('Cyclic Hono'))).toBe(true);
 const doc=converted.document as any;
 expect(Object.keys(doc.paths).sort()).toEqual(['/api/a/item','/api/b/item']);
 expect(doc.paths['/api/a/item'].post.requestBody.required).not.toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
