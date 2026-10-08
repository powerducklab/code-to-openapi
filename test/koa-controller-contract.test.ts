import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {scanProject} from '../src/index.js';
it('resolves imported controller instances and constant prefixes without guessing runtime paths',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koa-controller-'));
 try {
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{koa:'*','koa-router':'*'}}));
  await writeFile(join(root,'prefix.ts'),`export const version='v9';`);
  await writeFile(join(root,'controller.ts'),`const shape=()=>({total:3,title:'hello'});
class Catalog { async list(ctx:any){const result=shape();ctx.body=result} async single(ctx:any){ctx.body=ctx.query.flag?{name:'one'}:{count:2}} }
export default new Catalog();`);
  await writeFile(join(root,'app.ts'),"import Router from 'koa-router';import catalog from './controller';import {version as segment} from './prefix';const router=new Router();router.prefix(`/${segment}/catalog`);router.get('/',catalog.list);router.get('/one',catalog.single);const dynamic=new Router();dynamic.prefix(process.env.PREFIX);dynamic.get('/hidden',catalog.list);const child=new Router();child.get('/child-hidden',catalog.list);dynamic.use(child.routes());let mutable='/old';mutable='/new';const changing=new Router({prefix:mutable});changing.get('/unsafe',catalog.list);");
  const r=await scanProject({root,frameworks:['koa']});
  const paths=r.project.operations.map(o=>o.fullPath??o.path);
  expect(paths).toContain('/v9/catalog');expect(paths).toContain('/v9/catalog/one');
  expect(paths.some(p=>p.includes('hidden')||p.includes('unsafe'))).toBe(false);
  const list=r.project.operations.find(o=>(o.fullPath??o.path)==='/v9/catalog')!;
  expect(list.responses[0].content?.[0]?.schema).toMatchObject({properties:{total:{type:'integer'},title:{type:'string'}}});
  const single=r.project.operations.find(o=>(o.fullPath??o.path)==='/v9/catalog/one')!;
  expect(single.responses[0].content?.[0]?.schema?.anyOf).toHaveLength(2);
  expect((await r.convert({validate:true})).documentValid).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
