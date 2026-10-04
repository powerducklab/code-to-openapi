/** Execute original Express routers/mappers with DB/auth boundaries isolated. */
import {readFileSync,existsSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const [root,out]=process.argv.slice(2);const native=createRequire(import.meta.url),cache=new Map();
const user={id:3,email:'a@example.test',username:'alice',bio:'bio',image:'image',followedBy:[{id:8}]};
const prisma={user:{findUnique:async({select})=>select?Object.fromEntries(Object.keys(select).map(k=>[k,user[k]])):{...user}}};
function load(file){
 file=resolve(file);if(!existsSync(file))file=existsSync(file+'.ts')?file+'.ts':join(file,'index.ts');
 if(statSync(file).isDirectory())file=join(file,'index.ts');
 if(cache.has(file))return cache.get(file).exports;
 const module={exports:{}};cache.set(file,module);
 const js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019,esModuleInterop:true}}).outputText;
 const require=spec=>{
  if(spec.endsWith('prisma-client'))return {__esModule:true,default:prisma};
  if(spec.endsWith('/auth')||spec==='./auth')return {__esModule:true,default:{required:(_q,_r,next)=>next(),optional:(_q,_r,next)=>next()}};
  if(spec.endsWith('token.utils'))return {__esModule:true,default:()=> 'oracle-token'};
  if(['bcryptjs','slugify'].includes(spec))return new Proxy(()=>{}, {get:()=>()=>{throw Error('unexpected mocked operation')}});
  return spec.startsWith('.')?load(resolve(dirname(file),spec)):native(spec);
 };
 runInNewContext(`(function(require,module,exports){${js}\n})`,{console,Buffer,Date,Promise})(require,module,module.exports);
 return module.exports;
}
const paths={};
const visit=router=>{for(const layer of router.stack){if(layer.route){const path='/api'+layer.route.path.replace(/:([\w]+)/g,'{$1}');for(const method of Object.keys(layer.route.methods)){
 (paths[path]??={})[method]={parameters:[...path.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}})),responses:{}};
 }}else if(layer.handle?.stack)visit(layer.handle);}};
visit(load(join(root,'src/app/routes/routes.ts')).default);
const schema=value=>value===null?{type:'null'}:Array.isArray(value)?{type:'array',items:value.length?schema(value[0]):{}}:typeof value==='object'?{type:'object',properties:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,schema(v)])),required:Object.keys(value)}:{type:typeof value};
const articleMapper=load(join(root,'src/app/routes/article/article.mapper.ts')).default;
const article={slug:'post',title:'Post',description:'Description',body:'Body',tagList:[{name:'code'}],createdAt:new Date('2024-01-01'),updatedAt:new Date('2024-01-02'),favoritedBy:[{id:8}],author:user};
const mapped=JSON.parse(JSON.stringify(articleMapper(article,8)));
if(!mapped.favorited||!mapped.author.following||mapped.favoritesCount!==1||mapped.tagList[0]!=='code')throw Error('mapper mismatch');
const articleSchema=schema(mapped);
for(const key of ['bio','image'])articleSchema.properties.author.properties[key]={type:['string','null']};
const profileMapper=load(join(root,'src/app/routes/profile/profile.utils.ts')).default;
const profileSchema=schema(profileMapper(user,8));for(const key of ['bio','image'])profileSchema.properties[key]={type:['string','null']};
const current=await load(join(root,'src/app/routes/auth/auth.service.ts')).getCurrentUser(3);
if('password' in current||current.token!=='oracle-token')throw Error('user mapping mismatch');
const userSchema=schema(current);for(const key of ['bio','image'])userSchema.properties[key]={type:['string','null']};
// Status/envelope bindings independently transcribed from original controllers.
const body=(path,method,status,payload)=>{paths[path][method].responses[String(status)]={description:'Original handler success',...(payload?{content:{'application/json':{schema:payload}}}:{})};};
const wrap=(key,s)=>({type:'object',properties:{[key]:s},required:[key]});
for(const method of ['get','put'])body('/api/user',method,200,wrap('user',userSchema));
body('/api/users','post',201,wrap('user',userSchema));
const {id:discard,...loginProps}=userSchema.properties;
body('/api/users/login','post',200,wrap('user',{...userSchema,properties:loginProps,required:userSchema.required.filter(k=>k!=='id')}));
for(const method of ['get','put'])body('/api/articles/{slug}',method,200,wrap('article',articleSchema));
body('/api/articles','post',201,wrap('article',articleSchema));
for(const method of ['post','delete'])body('/api/articles/{slug}/favorite',method,200,wrap('article',articleSchema));
body('/api/articles/{slug}','delete',204);
body('/api/articles/{slug}/comments/{id}','delete',200,{type:'object'});
body('/api/profiles/{username}','get',200,wrap('profile',profileSchema));
for(const method of ['post','delete'])body('/api/profiles/{username}/follow',method,200,wrap('profile',profileSchema));
for(const p of ['/api/articles','/api/articles/feed'])body(p,'get',200,{type:'object',properties:{articles:{type:'array',items:articleSchema},articlesCount:{type:'number'}},required:['articles','articlesCount']});
for(const [p,names] of [['/api/articles',['tag','author','favorited','limit','offset']],['/api/articles/feed',['limit','offset']]])paths[p].get.parameters=names.map(name=>({name,in:'query',required:false,schema:{type:['limit','offset'].includes(name)?'number':'string'}}));
// Independent successful sample mappings are partial contracts, not all branches.
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify({openapi:'3.2.0',info:{title:'Express native routes and original mapping samples',version:'1'},paths},null,2));
console.log(JSON.stringify({operations:Object.values(paths).reduce((n,v)=>n+Object.keys(v).length,0),mapperChecks:['tagList','favorited','favoritesCount','author.following','password omitted'],limitations:'No DB/auth/password hashing. Nullable bio/image transcribed from Prisma. Error and comment response branches pending.'}));
