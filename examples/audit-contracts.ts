/** Independent contract comparison. Baseline MUST come from upstream contracts,
 * never from scanner output. Reports mismatches; does not bless unknown fields. */
import {readFileSync,writeFileSync} from 'node:fs';
const load=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const strict=process.argv.includes('--strict');
const args=process.argv.slice(2).filter(arg=>arg!=='--strict');
const baseline=load(args[0]!);
const scanned=load(args[1]!);
const actual=scanned.document??scanned;
const prefix=args[3]??'';
const errors:unknown[]=[];const baselineIssues:unknown[]=[];let assertions=0;
const resolvedNodes=new WeakMap<object,WeakMap<object,any>>();
function resolve(node:any,doc:any,seen=new Set<string>()):any{
 if(!node||typeof node!=='object')return node;
 let cache=resolvedNodes.get(doc);if(!cache){cache=new WeakMap();resolvedNodes.set(doc,cache);}
 if(cache.has(node))return cache.get(node);
 if(node?.$ref?.startsWith('#/')){
  if(seen.has(node.$ref))return node;
  const value=node.$ref.slice(2).split('/').reduce((v:any,k:string)=>v?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],doc);
  if (!value) return node;
  const {$ref, ...siblings} = node;
  const result=resolve(Object.keys(siblings).length ? {...value, ...siblings} : value,doc,new Set(seen).add(node.$ref));
  cache.set(node,result);return result;
 }
 return node;
}
function leaves(node:any,doc:any,path='',out=new Map<string,unknown>(),seen=new Set<any>(),includePropertySets=false):Map<string,unknown>{
 node=resolve(node,doc);if(!node||typeof node!=='object'||seen.has(node))return out;
 const next=new Set(seen).add(node);
 // Nullable refs and nullable primitive unions are equivalent to type unions.
 // Preserve their fields instead of reporting the whole branch as missing.
 for(const union of ['anyOf','oneOf']){
  const branches=node[union];
  if(!Array.isArray(branches)||branches.length!==2)continue;
  const resolved=branches.map((branch:any)=>resolve(branch,doc));
  const nullIndex=resolved.findIndex((branch:any)=>branch?.type==='null'&&Object.keys(branch).every(key=>['type','description','title'].includes(key)));
  if(nullIndex<0)continue;
  const value=resolved[1-nullIndex];
  if(!value?.type)continue;
  const {[union]:unused,...siblings}=node;
  node={...value,...siblings,type:[...new Set([...(Array.isArray(value.type)?value.type:[value.type]),'null'])]};
 }
 for(const key of ['type','format','enum','const','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','readOnly','writeOnly']){
  if(node[key]!==undefined) {
   const value = key === 'type' && node.nullable === true && typeof node.type === 'string' ? [node.type, 'null'] : node[key];
   out.set(path+'/'+key,value);
  }
 }
 if(node.properties&&(includePropertySets||node['x-audit-exact-properties']===true))out.set(path+'/propertyNames',Object.keys(node.properties).sort());
 for(const [key,value] of Object.entries(node.properties??{})){
  out.set(path+'/properties/'+key+'/present',true);
  if(!out.has(path+'/properties/'+key+'/required'))out.set(path+'/properties/'+key+'/required',false);
  leaves(value,doc,path+'/properties/'+key,out,next,includePropertySets);
 }
 if(node.items)leaves(node.items,doc,path+'/items',out,next,includePropertySets);
 for(const child of node.allOf??[])leaves(child,doc,path,out,next,includePropertySets);
 for(const key of node.required??[])out.set(path+'/properties/'+key+'/required',true);
 for(const key of ['oneOf','anyOf']) (node[key]??[]).forEach((child:any,i:number)=>leaves(child,doc,path+'/'+key+'/'+i,out,next,includePropertySets));
 return out;
}
function compare(expected:any,observed:any,where:string){
 const found=leaves(observed,actual,'',new Map(),new Set(),true);
 for(const [field,want] of leaves(expected,baseline)){
  assertions++;
  const got=found.get(field);
  const canonical=(value:any)=>Array.isArray(value)&&(/\/(type|enum)$/.test(field))?[...value].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):value;
  if(JSON.stringify(canonical(want))!==JSON.stringify(canonical(got)))errors.push({where,field,expected:want,actual:got??null});
 }
}
for(const [path,item] of Object.entries<any>(baseline.paths??{}))for(const method of ['get','post','put','patch','delete','head','options','trace']){
 const op=item[method];if(!op)continue;assertions++;
 const got=actual.paths?.[prefix+path]?.[method];const where=method+' '+prefix+path;
 if(!got){errors.push({where,error:'missing operation'});continue;}
 for(const raw of [...(item.parameters??[]),...(op.parameters??[])]){
  const p=resolve(raw,baseline);const ap=[...(actual.paths[prefix+path].parameters??[]),...(got.parameters??[])].map(p=>resolve(p,actual)).find(p2=>p2.name===p.name&&p2.in===p.in);
  assertions++;if(!ap){errors.push({where,error:'missing parameter',name:p.name,in:p.in});continue;}
  assertions++;if(!!p.required!==!!ap.required)errors.push({where,parameter:p.name,error:'required mismatch',expected:!!p.required,actual:!!ap.required});
  compare(p.schema,ap.schema,where+' '+p.in+':'+p.name);
 }
 const expectedBody=resolve(op.requestBody,baseline);const actualBody=resolve(got.requestBody,actual);
 if(expectedBody){assertions++;if(!!expectedBody.required!==!!actualBody?.required)errors.push({where,error:'request body required mismatch',expected:!!expectedBody.required,actual:!!actualBody?.required});}
 for(const [media,entry] of Object.entries<any>(expectedBody?.content??{})){
  assertions++;if(!actualBody?.content?.[media])errors.push({where,error:'missing request media',media});
  compare(entry.schema,resolve(got.requestBody,actual)?.content?.[media]?.schema,where+' request '+media);
 }
 for(const [status,raw] of Object.entries<any>(op.responses??{})){
  assertions++;const response=resolve(got.responses?.[status],actual);
  if(!response){errors.push({where,error:'missing response',status});continue;}
  if (/^(1\d\d|204|205|304)$/.test(status)) {
   assertions++;
   if (Object.keys(resolve(raw,baseline)?.content??{}).length) baselineIssues.push({where,status,error:'Baseline declares content for a bodyless status'});
   if (Object.keys(response.content??{}).length) errors.push({where,status,error:'Bodyless response has content'});
  } else for(const [media,entry] of Object.entries<any>(resolve(raw,baseline)?.content??{})){
   assertions++;if(!response.content?.[media])errors.push({where,status,error:'missing response media',media});
   compare(entry.schema,response.content?.[media]?.schema,where+' response '+status+' '+media);
  }
 }
}
const result={assertions,mismatches:errors.length,errors,baselineIssues,limitation:'Checks documented properties/constraints. Extra fields, business semantics and undocumented runtime branches require separate review.'};
writeFileSync(args[2]!,JSON.stringify(result,null,2));console.log(JSON.stringify({assertions,mismatches:errors.length}));

if(strict && (errors.length || baselineIssues.length || !assertions)) process.exitCode=1;
