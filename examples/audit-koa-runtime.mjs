/** Native pinned Koa/Yup oracle; original schemas, router and user handler. */
import {readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {IncomingMessage,ServerResponse} from 'node:http';
import {Socket} from 'node:net';
const [root,deps,out]=process.argv.slice(2);const native=createRequire(resolve(deps,'package.json')),cache=new Map();
const db=()=>({insert:async()=>{}});
function load(file){
 file=resolve(file);if(!existsSync(file))file=existsSync(file+'.js')?file+'.js':join(file,'index.js');if(statSync(file).isDirectory())file=join(file,'index.js');
 if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);
 const require=spec=>{
  if(spec.endsWith('/lib/db'))return db;
  if(spec==='bcrypt')return {hash:async()=> 'isolated-hash',compare:async()=>{throw Error('password verification not tested')}};
  if(spec==='config')return {get:()=> 'isolated-oracle'};
  if(spec==='jsonwebtoken')return {sign:()=> 'oracle-token'};
  if(spec==='slug')return ()=>{throw Error('slug execution not tested')};
  if(spec==='join-js')return {default:{}};
  return spec.startsWith('.')?load(resolve(dirname(file),spec)):native(spec);
 };
 runInNewContext(`(function(require,module,exports){${readFileSync(file,'utf8')}\n})`,{console,Buffer,Date,Promise})(require,module,module.exports);return module.exports;
}
const router=load(join(root,'src/routes/index.js'));const paths={};
for(const layer of router.stack){for(const method of layer.methods){if(method==='HEAD'&&layer.methods.includes('GET'))continue;
 const path=layer.path.replace(/:([\w]+)/g,'{$1}');
 (paths[path]??={})[method.toLowerCase()]={parameters:[...path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}})),responses:{}};
}}
const Koa=native('koa');const app=new Koa();load(join(root,'src/schemas/index.js'))(app);
const valid={email:'person@example.test',username:'person',password:'abcdefgh'};
const options={context:{validatePassword:true},abortEarly:false};
let rejected=false;try{await app.schemas.user.validate({...valid,password:'short'},options);}catch{rejected=true;}
if(!rejected)throw Error('native password validation did not reject short input');
const properties={},required=[];
for(const [key,raw] of Object.entries(app.schemas.user.fields)){
 if(key==='id')continue; // original controller overwrites it before validation
 const field=raw.resolve({...options,parent:valid,value:valid[key]});const desc=field.describe();
 const schema={type:desc.type};
 for(const test of field.tests.map(t=>t.TEST).filter(Boolean)){if(test.name==='min')schema.minLength=test.params.min;if(test.name==='max')schema.maxLength=test.params.max;if(test.name==='email')schema.format='email';if(test.name==='url')schema.format='uri';}
 properties[key]=schema;
 const missing={...valid};delete missing[key];
 if(!(await app.schemas.user.isValid(missing,options)))required.push(key);
}
const request={type:'object',properties:{user:{type:'object',properties,required}},required:['user']};
paths['/api/users'].post.requestBody={required:true,content:{'application/json':{schema:request}}};
const req=new IncomingMessage(new Socket());req.method='POST';req.url='/api/users';const res=new ServerResponse(req);const ctx=app.createContext(req,res);ctx.request.body={user:{...valid}};
await load(join(root,'src/controllers/users-controller.js')).post(ctx);
if(ctx.status!==200||'password' in ctx.body.user||ctx.body.user.token!=='oracle-token')throw Error('original user handler serialization mismatch');
const responseSchema={type:'object',properties:{user:{type:'object',properties:Object.fromEntries(Object.entries(ctx.body.user).map(([key,value])=>[key,{type:typeof value}])),required:Object.keys(ctx.body.user)}},required:['user']};
paths['/api/users'].post.responses={'200':{description:'Native Koa body status',content:{'application/json':{schema:responseSchema}}}};
req.destroy();res.destroy();
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({openapi:'3.2.0',info:{title:'Native Koa router and Yup user contract',version:'1'},paths},null,2));
console.log(JSON.stringify({operations:Object.values(paths).reduce((n,v)=>n+Object.keys(v).length,0),requiredInput:required,responseKeys:Object.keys(ctx.body.user),passwordRejected:rejected,limitations:'Only original user post handler executed; isolated DB insert, password hashing and JWT signing doubles; other handler responses/middleware pending.'}));
