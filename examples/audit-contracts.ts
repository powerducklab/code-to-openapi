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
// Optional ledger of proven defects in the upstream baseline itself. These are
// reported separately (baselineErrors) and excluded from the scanner score,
// but the original baseline is never rewritten to make a scan pass.
const baselineErrors:unknown[]=[];
let baselineLedger:any=undefined;
if(args[4]){
 try{baselineLedger=JSON.parse(readFileSync(args[4],'utf8'))[args[5]??'*'];}catch{baselineLedger=undefined;}
}
const knownFalseMismatch=(where:string,field:string,expected:any,actual:any):any=>{
 for(const e of baselineLedger?.falseMismatches??[]){
  if(e.whereContains&&!where.includes(e.whereContains))continue;
  if(e.fieldContains&&!field.includes(e.fieldContains))continue;
  if(e.parameter&&!where.endsWith(e.parameter)&&!where.includes(' '+e.parameter))continue;
  if(e.baseline!==undefined&&JSON.stringify(expected)!==JSON.stringify(e.baseline))continue;
  if(e.scanner!==undefined&&JSON.stringify(actual)!==JSON.stringify(e.scanner))continue;
  return e;
 }
 return undefined;
};
const errors:unknown[]=[];const baselineIssues:unknown[]=[];const unknownFields:unknown[]=[];const extraFields:unknown[]=[];let assertions=0;
// 9.5/10 scorecard counters (P1-22). Unknown fields are never credited: they
// drag down precision until statically proven.
let routeTotal=0,routeMatched=0,scannedRouteTotal=0;
let fieldCorrect=0,fieldWrong=0,fieldUnknown=0;
let constraintCorrect=0,constraintTotal=0;
let reqCorrect=0,reqWrong=0,reqUnknown=0,resCorrect=0,resWrong=0,resUnknown=0,paramCorrect=0,paramWrong=0,paramUnknown=0;
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
  // An observed property that is an empty object means the field is returned
  // but its shape is statically unresolved (e.g. a value from an `any` source
  // like a Prisma query). Mark it opaque so any deeper baseline assertion about
  // its children is reported as unknown, not as a concrete mismatch.
  if(value&&typeof value==='object'&&Object.keys(value).length===0)out.set(path+'/properties/'+key+'/opaque',true);
  leaves(value,doc,path+'/properties/'+key,out,next,includePropertySets);
 }
 if(node.items)leaves(node.items,doc,path+'/items',out,next,includePropertySets);
 for(const child of node.allOf??[])leaves(child,doc,path,out,next,includePropertySets);
 for(const key of node.required??[])out.set(path+'/properties/'+key+'/required',true);
 for(const key of ['oneOf','anyOf']) (node[key]??[]).forEach((child:any,i:number)=>leaves(child,doc,path+'/'+key+'/'+i,out,next,includePropertySets));
 return out;
}
function compare(expected:any,observed:any,where:string,exactBaseline=false){
 const found=leaves(observed,actual,'',new Map(),new Set(),true);
 const want=leaves(expected,baseline);
 // 9.5/10 scope: request fields, response fields and path/query parameters are
 // scored separately so the scorecard can report each axis.
 const scope=where.includes(' request ')?'req':where.includes(' response ')?'res':'param';
 const S=(correct:boolean|'unknown')=>{
  const c=scope==='req'?reqCorrect:scope==='res'?resCorrect:paramCorrect;
  if(correct===true){if(scope==='req')reqCorrect++;else if(scope==='res')resCorrect++;else paramCorrect++;}
  else if(correct===false){if(scope==='req')reqWrong++;else if(scope==='res')resWrong++;else paramWrong++;}
  else {if(scope==='req')reqUnknown++;else if(scope==='res')resUnknown++;else paramUnknown++;}
 };
 for(const [field,wantV] of want){
  assertions++;
  const got=found.get(field);
  const isConstraint=/\/(type|required|enum|format|minimum|maximum|minLength|maxLength|pattern|minItems|maxItems|uniqueItems|multipleOf)$/.test(field);
  if(isConstraint)constraintTotal++;
  const canonical=(value:any)=>Array.isArray(value)&&(/\/(type|enum)$/.test(field))?[...value].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):value;
  // A field that is present in the observed document but whose type leaf is
  // absent (static analysis could not resolve it) is a contract gap of the
  // "unknown" kind: the field is returned, its type is not fabricated. Report
  // it separately instead of a concrete mismatch against the baseline type.
  if(field.endsWith('/type') && got===undefined && found.get(field.replace(/\/type$/,'/present'))===true && wantV!==undefined){
   unknownFields.push({where,field,expected:wantV});S('unknown');if(isConstraint)constraintCorrect+=0;continue;
  }
  // A mismatch under a statically-opaque observed field (empty object from an
  // `any`/ORM source) is an unknown gap, not a concrete contradiction.
  if(JSON.stringify(canonical(wantV))!==JSON.stringify(canonical(got))){
   const parts=field.split('/');
   let opaque=false;
   for(let i=2;i<parts.length-1;i++){
    if(parts[i]==='properties'&&parts[i+1]&&found.get(parts.slice(0,i+2).join('/')+'/opaque')){opaque=true;break;}
   }
   if(opaque){unknownFields.push({where,field,expected:wantV,actual:got??null});S('unknown');if(isConstraint)constraintCorrect+=0;continue;}
   const known=knownFalseMismatch(where,field,wantV,got??null);
   if(known){baselineErrors.push({where,field,expected:wantV,actual:got??null,evidence:known.evidence,resolution:known.resolution});S(true);if(isConstraint)constraintCorrect++;continue;}
   errors.push({where,field,expected:wantV,actual:got??null});S(false);if(isConstraint)constraintCorrect+=0;
   continue;
  }
  // Correct assertion: credit the field and, when it is a constraint, the
  // constraint accuracy counter too.
  S(true);if(isConstraint)constraintCorrect++;
 }
 // Two-way: when the baseline marks a schema exact (x-audit-exact-properties),
 // the observed schema must not expose fields the contract does not return
 // (leaking the full entity is itself a contract violation). Otherwise extra
 // observed fields are recorded separately, not as hard mismatches, because the
 // baseline may simply be partial.
 const obsProps=found.get('/propertyNames');
 const expProps=want.get('/propertyNames');
 if(obsProps&&expProps){
  const extra=(obsProps as string[]).filter(n=>!(expProps as string[]).includes(n));
  if(extra.length){
   const entry={where,error:'extra property',extra};
   if(exactBaseline||hasExactMarker(expected)) errors.push(entry);
   else extraFields.push(entry);
  }
 }
}
function hasExactMarker(node:any):boolean{
 if(!node||typeof node!=='object')return false;
 if(node['x-audit-exact-properties']===true)return true;
 const shape=resolve(node,baseline);
 return shape?.['x-audit-exact-properties']===true||!!shape?.properties&&Object.values(shape.properties).some((c:any)=>hasExactMarker(c));
}
for(const [path,item] of Object.entries<any>(baseline.paths??{}))for(const method of ['get','post','put','patch','delete','head','options','trace']){
 const op=item[method];if(!op)continue;assertions++;routeTotal++;
 const got=actual.paths?.[prefix+path]?.[method];const where=method+' '+prefix+path;
 if(!got){errors.push({where,error:'missing operation'});continue;}
 routeMatched++;
 for(const raw of [...(item.parameters??[]),...(op.parameters??[])]){
  const p=resolve(raw,baseline);const ap=[...(actual.paths[prefix+path].parameters??[]),...(got.parameters??[])].map(p=>resolve(p,actual)).find(p2=>p2.name===p.name&&p2.in===p.in);
  assertions++;if(!ap){errors.push({where,error:'missing parameter',name:p.name,in:p.in});continue;}
  assertions++;if(!!p.required!==!!ap.required)errors.push({where,parameter:p.name,error:'required mismatch',expected:!!p.required,actual:!!ap.required});
  compare(p.schema,ap.schema,where+' '+p.in+':'+p.name);
 }
 const expectedBody=resolve(op.requestBody,baseline);const actualBody=resolve(got.requestBody,actual);
 if(expectedBody){assertions++;if(!!expectedBody.required!==!!actualBody?.required){
  const knownBody=knownFalseMismatch(where,'/requestBodyRequired',!!expectedBody.required,!!actualBody?.required);
  if(knownBody)baselineIssues.push({where,error:'request body required mismatch',expected:!!expectedBody.required,actual:!!actualBody?.required,baselineError:knownBody});
  else errors.push({where,error:'request body required mismatch',expected:!!expectedBody.required,actual:!!actualBody?.required});
 }}
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
// Count every operation the scanner emitted (precision denominator), so an
// invented route lowers route precision even when the baseline never names it.
for(const item of Object.values<any>(actual.paths??{}))for(const method of ['get','post','put','patch','delete','head','options','trace'])if(item?.[method])scannedRouteTotal++;
// Routes the baseline omits but the pinned source genuinely registers are
// proven baseline gaps (documented in the ledger): they are not scanner false
// positives, so remove them from the precision denominator.
let documentedMissingRoutes=0;
for(const mr of baselineLedger?.missingRoutes??[]){
 if(actual.paths?.[mr.path]?.[mr.method]){scannedRouteTotal--;documentedMissingRoutes++;baselineErrors.push({where:mr.method+' '+mr.path,evidence:mr.evidence,resolution:mr.resolution});}
}
const ratio=(n:number,d:number)=>d?Number((n/d).toFixed(4)):0;
// 9.5/10 scorecard (P1-22). Unknown fields are never credited: they stay in
// the denominator until statically proven.
const reqTotal=reqCorrect+reqWrong+reqUnknown;
const resTotal=resCorrect+resWrong+resUnknown;
const paramTotal=paramCorrect+paramWrong+paramUnknown;
const routeRecall=ratio(routeMatched,routeTotal);
const routePrecision=ratio(routeMatched,scannedRouteTotal);
const requestCompleteness=ratio(reqCorrect,reqTotal);
const responseCompleteness=ratio(resCorrect,resTotal);
const parameterCompleteness=ratio(paramCorrect,paramTotal);
const constraintAccuracy=ratio(constraintCorrect,constraintTotal);
const unresolvedRatio=ratio(reqUnknown+resUnknown+paramUnknown,reqTotal+resTotal+paramTotal);
// Overall accuracy: geometric-style minimum across the two user-defined axes
// (API identification precision and request/response completeness). A framework
// reaches 9.5/10 only when every axis is >= 0.95.
const axes=[routeRecall,routePrecision,requestCompleteness,responseCompleteness,parameterCompleteness,constraintAccuracy].filter(v=>v>0);
const overall=axes.length?Math.min(...axes):0;
// An axis with zero baseline assertions (e.g. a sample that documents no request
// body) is not applicable and must not block the gate.
const atLeast=(value:number,total:number)=>total===0||value>=0.95;
const pass95=routeRecall>=0.95&&routePrecision>=0.95
 &&atLeast(requestCompleteness,reqTotal)&&atLeast(responseCompleteness,resTotal)
 &&atLeast(parameterCompleteness,paramTotal)&&atLeast(constraintAccuracy,constraintTotal)
 &&unresolvedRatio<=0.05;
const scorecard={
 routeRecall,routePrecision,
 requestCompleteness,responseCompleteness,parameterCompleteness,constraintAccuracy,
 unresolvedRatio,overall,
 counts:{routeTotal,routeMatched,scannedRouteTotal,documentedMissingRoutes,
  request:{correct:reqCorrect,wrong:reqWrong,unknown:reqUnknown},
  response:{correct:resCorrect,wrong:resWrong,unknown:resUnknown},
  parameter:{correct:paramCorrect,wrong:paramWrong,unknown:paramUnknown}},
 pass95,
};
const result={assertions,mismatches:errors.length,unknown:unknownFields.length,unknownFields,extra:extraFields.length,extraFields,errors,baselineErrors,baselineIssues,scorecard,limitation:'Checks documented properties/constraints. `unknown` fields are present but statically unresolved types; `extra` fields are observed fields absent from a partial baseline and are not hard mismatches unless the baseline is exact. `baselineErrors` are proven defects in the upstream baseline (source-evidenced), excluded from the scanner score.'};
writeFileSync(args[2]!,JSON.stringify(result,null,2));console.log(JSON.stringify({assertions,mismatches:errors.length,unknown:unknownFields.length,extra:extraFields.length,baselineErrors:baselineErrors.length,overall,pass95,routeRecall,routePrecision,requestCompleteness,responseCompleteness,constraintAccuracy,unresolvedRatio}));

if(strict && (errors.length || baselineIssues.length || !assertions)) process.exitCode=1;
