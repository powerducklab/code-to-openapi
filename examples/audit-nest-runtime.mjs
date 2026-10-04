/** Native Nest decorator/validation oracle. No DB/network/business side effects. */
import {readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const [root,deps,out]=process.argv.slice(2);
const native=createRequire(resolve(deps,'package.json'));
native('reflect-metadata');
const common=native('@nestjs/common');
const cache=new Map();
const noOpDecorator=()=>()=>{};
const orm=new Proxy({}, {get:(_,key)=>key==='Repository'?class Repository{}:noOpDecorator});
function load(file){
 file=resolve(file);if(!existsSync(file))file=existsSync(file+'.ts')?file+'.ts':join(file,'index.ts');
 if(statSync(file).isDirectory())file=join(file,'index.ts');
 if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);
 const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019,experimentalDecorators:true,emitDecoratorMetadata:true}}).outputText;
 const require=spec=>{
  if(spec==='typeorm')return orm;
  if(spec==='@nestjs/typeorm')return {InjectRepository:noOpDecorator};
  if(spec==='argon2')return {hash:()=>{throw Error('unexpected password hashing')},verify:()=>{throw Error('unexpected password verification')}};
  if(spec==='jsonwebtoken')return {sign:()=> 'oracle-token',verify:()=>{throw Error('unexpected JWT verify')}};
  if(spec==='slug')return value=>value;
  if(spec.endsWith('/config'))return {SECRET:'isolated-oracle'};
  return spec.startsWith('.')?load(resolve(dirname(file),spec)):native(spec);
 };
 runInNewContext(`(function(require,module,exports){${js}\n})`,{Reflect,console,Buffer,Date,Promise})(require,module,module.exports);
 return module.exports;
}
const paths={};const methods=['get','post','put','delete','patch','all','options','head'];
for(const [dir,name] of [['app','App'],['article','Article'],['user','User'],['profile','Profile'],['tag','Tag']]){
 const file=dir==='app'?'src/app.controller.ts':`src/${dir}/${dir}.controller.ts`;
 const C=load(join(root,file))[name+'Controller'];
 for(const key of Object.getOwnPropertyNames(C.prototype)){
  const handler=C.prototype[key],verb=Reflect.getMetadata('method',handler);
  if(verb===undefined)continue;
  const path=('/api/'+(Reflect.getMetadata('path',C)??'')+'/'+(Reflect.getMetadata('path',handler)??'')).replace(/\/+/g,'/').replace(/\/$/,'').replace(/:([\w]+)/g,'{$1}');
  const method=methods[verb];const status=String(Reflect.getMetadata('__httpCode__',handler)??(method==='post'?201:200));
  (paths[path]??={})[method]={parameters:[...path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}})),responses:{[status]:{description:'Native Nest default status'}}};
 }
}
const {ValidationPipe}=load(join(root,'src/shared/pipes/validation.pipe.ts'));
const {CreateUserDto}=load(join(root,'src/user/dto/create-user.dto.ts'));
const pipe=new ValidationPipe();
let rejected=false;try{await pipe.transform({},{metatype:CreateUserDto});}catch(error){rejected=error.getStatus()===400;}
if(!rejected)throw Error('native validation did not reject missing fields');
await pipe.transform({username:'user',email:'user@example.test',password:'secret'},{metatype:CreateUserDto});
const string={type:'string'};
for(const [path,fields] of [['/api/users',['username','email','password']],['/api/users/login',['email','password']]]){
 paths[path].post.requestBody={required:true,content:{'application/json':{schema:{type:'object',properties:{user:{type:'object',properties:Object.fromEntries(fields.map(k=>[k,string])),required:fields}},required:['user']}}}};
}
const {UserService}=load(join(root,'src/user/user.service.ts'));
const stored={id:11,username:'user',email:'user@example.test',bio:'bio',image:'https://example.test/a.png',password:'hidden'};
const userService=new UserService({findOne:async()=>({...stored})});
const me=await userService.findByEmail(stored.email);
if('password' in me.user || !('id' in me.user))throw Error('unexpected actual user serializer');
const userSchema={type:'object',properties:{user:{type:'object',properties:Object.fromEntries(Object.entries(me.user).map(([k,v])=>[k,{type:typeof v==='number'?'number':'string'}])),required:Object.keys(me.user)}},required:['user']};
for(const [p,m,s] of [['/api/user','get','200'],['/api/users','post','201']])paths[p][m].responses[s].content={'application/json':{schema:userSchema}};
paths['/api'].get.responses['200'].content={'text/html':{schema:{type:'string'}}};
// Service query contracts are transcribed from findAll/findFeed accesses, not scanner output.
for(const [path,keys] of [['/api/articles',['tag','author','favorited','limit','offset']],['/api/articles/feed',['limit','offset']]])paths[path].get.parameters=keys.map(name=>({name,in:'query',required:false,schema:{type:'string'}}));
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({openapi:'3.2.0',info:{title:'Pinned Nest native metadata and validated contracts',version:'1'},paths},null,2));
console.log(JSON.stringify({operations:Object.values(paths).reduce((n,v)=>n+Object.keys(v).length,0),validationRejectedMissingFields:rejected,actualSerializedUserFields:Object.keys(me.user),limitations:'ORM and JWT signing are stubs; no database/auth/network validation. Native Nest decorators, original validation pipe and original user mapping execute.'}));
