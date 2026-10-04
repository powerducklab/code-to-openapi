import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('preserves explicit router middleware responses without leaking them to unrelated routes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'express-middleware-'));
 try{
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{express:'*'}}));
 await writeFile(join(root,'app.ts'),`import express from 'express';
const app=express();const router=express.Router();
function auth(req,res,next){if(!req.headers.authorization)return res.status(401).json({error:'missing token'});next()}
router.get('/before',(req,res)=>res.json({ok:true}));router.use(auth);router.get('/items',(req,res)=>res.json({items:['a']}));
app.use('/private',router);app.get('/public',(req,res)=>res.json({ok:true}));app.listen(3000);`);
 const result=await scanProject({root});const converted=await result.convert();
 expect(converted.documentValid).toBe(true);
 const doc=converted.document as any;
 expect(doc.paths['/private/items'].get.responses['401'].content['application/json'].schema.properties.error.type).toBe('string');
 expect(doc.paths['/private/items'].get.responses['200']).toBeDefined();
 expect(doc.paths['/private/before'].get.responses['401']).toBeUndefined();
 expect(doc.paths['/public'].get.responses['401']).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
