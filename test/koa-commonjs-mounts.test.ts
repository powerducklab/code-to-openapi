import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('resolves CommonJS middleware exports, nested controller objects and del aliases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koa-mount-'));
 try {
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{koa:'*','koa-router':'*'}}));
 await writeFile(join(root,'controller.js'),`module.exports={nested:{get(ctx){ctx.body={ok:true}},del(ctx){ctx.status=204;ctx.body=null}}};`);
 await writeFile(join(root,'child.js'),`const Router=require('koa-router');const ctrl=require('./controller').nested;const router=new Router({prefix:'/v1'});router.get('/items',ctrl.get);router.del('/items/:id',ctrl.del);module.exports=router.routes();`);
 await writeFile(join(root,'app.js'),`const Router=require('koa-router');const child=require('./child');const api=new Router();api.use('/a',child);api.use('/b',child);const root=new Router();root.use('/api',api.routes());module.exports=root;`);
 const result=await scanProject({root});const converted=await result.convert();const doc=converted.document as any;
 expect(converted.documentValid).toBe(true);
 expect(Object.keys(doc.paths).sort()).toEqual(['/api/a/v1/items','/api/a/v1/items/{id}','/api/b/v1/items','/api/b/v1/items/{id}']);
 expect(doc.paths['/api/a/v1/items'].get.responses['200'].content['application/json'].schema.properties.ok.type).toBe('boolean');
 expect(doc.paths['/api/b/v1/items/{id}'].delete.responses['204'].content).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
