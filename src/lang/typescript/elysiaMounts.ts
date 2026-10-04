import type {TsAnalysis} from './index.js';
import type {ExtractionResult} from '../../core/types.js';
import {joinPath} from './httpRoute.js';

/** Resolve fluent Elysia plugin identities through lexical symbols, never files
 * or function names. A file can declare multiple unrelated applications. */
export function elysiaMounts(analysis: TsAnalysis) {
 const {ts,checker}=analysis;
 const owners=new Map<string,{prefix:string,file:string}>();
 const edges:Array<{parent:string,child:string,prefix:string}>=[];
 const unresolved:ExtractionResult['unresolved']=[];
 const key=(node:any)=>`${node.getSourceFile().fileName}:${node.pos}`;
 const declarations=(node:any)=>{
  let symbol=checker.getSymbolAtLocation(node);
  if(symbol?.flags & ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
  return symbol?.declarations??[];
 };
 const owner=(node:any,seen=new Set<any>(),depth=0):string|null=>{
  if(!node||depth>24||seen.has(node))return null;
  const next=new Set(seen).add(node);
  if(ts.isPropertyAccessExpression(node))return owner(node.expression,next,depth+1);
  if(ts.isCallExpression(node)) {
   if(ts.isPropertyAccessExpression(node.expression))return owner(node.expression.expression,next,depth+1);
   return owner(node.expression,next,depth+1);
  }
  if(ts.isIdentifier(node)) {
   const defs=declarations(node);
   const param=defs.find((d:any)=>ts.isParameter(d));
   if(param){
    const call=param.parent?.parent;
    if(call&&ts.isCallExpression(call)&&ts.isPropertyAccessExpression(call.expression)&&['group','guard'].includes(call.expression.name.text))return owner(call.expression.expression,next,depth+1);
    return null;
   }
   const variable=defs.find((d:any)=>ts.isVariableDeclaration(d)&&d.initializer);
   if(variable){
    if(ts.isArrowFunction(variable.initializer)||ts.isFunctionExpression(variable.initializer))return fromFunction(variable.initializer,next,depth+1);
    return owner(variable.initializer,next,depth+1);
   }
   const fn=defs.find((d:any)=>ts.isFunctionDeclaration(d)&&d.body);
   return fn?fromFunction(fn,next,depth+1):null;
  }
  if(ts.isNewExpression(node)) {
   const ctor=checker.getSymbolAtLocation(node.expression);
   const proven=(ctor?.declarations??[]).some((d:any)=>(ts.isImportSpecifier(d)&&(d.propertyName?.text??d.name.text)==='Elysia'&&d.parent?.parent?.parent?.moduleSpecifier?.text==='elysia')||(ts.isImportClause(d)&&d.name?.text===node.expression.text&&d.parent?.moduleSpecifier?.text==='elysia'));
   if(!proven)return null;
   const id=key(node);
   if(!owners.has(id)){
    const options=node.arguments?.[0];
    const prefix=options&&ts.isObjectLiteralExpression(options)?options.properties.find((p:any)=>ts.isPropertyAssignment(p)&&p.name.getText()==='prefix')?.initializer:null;
    owners.set(id,{prefix:prefix&&ts.isStringLiteralLike(prefix)?prefix.text:'',file:node.getSourceFile().fileName});
    if(prefix&&!ts.isStringLiteralLike(prefix))unresolved.push({reason:'path-dynamic',message:'Nonliteral Elysia constructor prefix requires review',origin:{file:node.getSourceFile().fileName}});
   }
   return id;
  }
  return null;
 };
 const fromFunction=(fn:any,seen:Set<any>,depth:number):string|null=>{
  if(!fn.body||!analysis.isProjectFile(fn.getSourceFile().fileName))return null;
  if(!ts.isBlock(fn.body))return owner(fn.body,seen,depth+1);
  const returns:any[]=[];
  const visit=(n:any)=>{if(n!==fn.body&&ts.isFunctionLike(n))return;if(ts.isReturnStatement(n))returns.push(n.expression);ts.forEachChild(n,visit);};
  visit(fn.body);
  const ids=returns.map(n=>owner(n,seen,depth+1));
  return ids.length&&ids.every(id=>id!==null&&id===ids[0])?ids[0]!:null;
 };
 const groupPrefix=(node:any)=>{
  const pieces:string[]=[];
  for(let n=node;n;n=n.parent){
   if((ts.isArrowFunction(n)||ts.isFunctionExpression(n))&&ts.isCallExpression(n.parent)&&ts.isPropertyAccessExpression(n.parent.expression)&&n.parent.expression.name.text==='group'){
    const p=n.parent.arguments[0];if(p&&ts.isStringLiteralLike(p))pieces.unshift(p.text);
   }
  }
  return pieces.join('');
 };
 for(const source of analysis.sourceByPath.values()){
  const visit=(node:any)=>{
   if(ts.isNewExpression(node))owner(node);
   if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='use'){
    const parent=owner(node.expression.expression),child=owner(node.arguments[0]);
    if(parent&&child)edges.push({parent,child,prefix:groupPrefix(node)});
   }
   ts.forEachChild(node,visit);
  };source.forEachChild(visit);
 }
 const incoming=new Set(edges.filter(e=>e.parent!==e.child).map(e=>e.child));
 const outgoing=new Map<string,typeof edges>();
 for(const edge of edges)outgoing.set(edge.parent,[...(outgoing.get(edge.parent)??[]),edge]);
 const prefixes=new Map<string,string[]>(),visited=new Set<string>(),cycles=new Set<string>();
 const walk=(root:string)=>{
  const pending=[{id:root,prefix:owners.get(root)?.prefix??'',ancestors:new Set<string>()}];
  while(pending.length){
   const {id,prefix,ancestors}=pending.pop()!;
   if(ancestors.has(id)){
    if(!cycles.has(id))unresolved.push({reason:'path-dynamic',message:'Cyclic Elysia plugin mount requires review',origin:{file:owners.get(id)?.file??''}});
    cycles.add(id);continue;
   }
   const state=id+'\0'+prefix;if(visited.has(state))continue;
   if(visited.size>=10000){if(!unresolved.some(u=>u.message.includes('10000')))unresolved.push({reason:'path-dynamic',message:'Elysia plugin expansion exceeded 10000 paths',origin:{file:owners.get(id)?.file??''}});return;}
   visited.add(state);prefixes.set(id,[...(prefixes.get(id)??[]),prefix]);
   const next=new Set(ancestors).add(id);
   for(const e of outgoing.get(id)??[])pending.push({id:e.child,prefix:joinPath(prefix,e.prefix,owners.get(e.child)?.prefix??''),ancestors:next});
  }
 };
 for(const id of owners.keys())if(!incoming.has(id))walk(id);
 for(const id of owners.keys())if(!prefixes.has(id))walk(id);
 return {unresolved,prefixesFor:(registration:any)=>{const id=owner(registration.expression.expression);return id?prefixes.get(id)??['']:[];}};
}
