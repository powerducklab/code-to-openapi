import {expect,it} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../src/index.js';
it('preserves Yup defaults, contextual validation and the actual Koa serializer',async()=>{
 const root=await mkdtemp(join(tmpdir(),'koa-yup-'));
 try {
 await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{koa:'*','koa-router':'*',yup:'0.26.6',lodash:'*',jsonwebtoken:'*'}}));
 await writeFile(join(root,'schemas.js'),`const yup=require('yup');module.exports=app=>{app.schemas={user:yup.object({
 username:yup.string().required().default(''),bio:yup.string().default(''),
 password:yup.string().when('$secure',{is:true,then:yup.string().required().min(8)}),
 image:yup.string().nullable().max(30),tags:yup.array(yup.string()),id:yup.string()
 })}};`);
 await writeFile(join(root,'token.js'),`const jwt=require('jsonwebtoken');exports.token=user=>Object.assign({},user,{token:jwt.sign({id:user.id},'secret',{expiresIn:'1d'})});`);
 await writeFile(join(root,'app.js'),`const Koa=require('koa');const Router=require('koa-router');const _=require('lodash');const {token}=require('./token');const app=new Koa();require('./schemas')(app);const router=new Router();
 router.post('/users',async ctx=>{let {user}=ctx.request.body;user.id='generated';user=await ctx.app.schemas.user.validate(user,{context:{secure:true}});user=token(user);delete user.id;user.bio=123;ctx.body={user:_.omit(user,['password'])}});
 router.post('/unknown',async ctx=>{let {user}=ctx.request.body;user=await ctx.app.schemas.user.validate(user);ctx.body={user}});app.use(router.routes());`);
 const result=await scanProject({root});const converted=await result.convert();const doc=converted.document as any;
 expect(converted.documentValid).toBe(true);
 const op=doc.paths['/users'].post;
 const input=op.requestBody.content['application/json'].schema.properties.user;
 expect(input.required).toEqual(expect.arrayContaining(['username','password']));
 expect(input.required).not.toContain('bio');expect(input.properties.id).toBeUndefined();
 expect(input.properties.image.anyOf).toContainEqual({type:'string',maxLength:30});
 expect(input.properties.tags.items.type).toBe('string');
 const output=op.responses['200'].content['application/json'].schema.properties.user;
 expect(output.properties.password).toBeUndefined();expect(output.properties.id).toBeUndefined();
 expect(output.properties.token.type).toBe('string');expect(output.properties.bio.type).toBe('integer');
 expect(output.required).toContain('bio');
 const unknown=doc.paths['/unknown'].post.requestBody.content['application/json'].schema.properties.user;
 expect(unknown.properties.password).toEqual({});
 expect(result.project.operations.find(o=>(o.fullPath??o.path)==='/unknown')?.gaps).toContain('body-schema-unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
