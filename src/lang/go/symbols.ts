/** Package-scoped Go symbols. Ambiguous or external declarations stay unresolved. */
import { dirname } from 'node:path';
import type { GoAnalysis, GoFile, GoFunction } from './index.js';
import type { TsNode } from '../treesitter/runtime.js';
import { findAll } from '../treesitter/ast.js';
interface TypeDeclaration { name:string; file:GoFile; node:TsNode; type:TsNode }
interface Symbols { files:Map<number,GoFile>; types:TypeDeclaration[] }
const cache=new WeakMap<GoAnalysis,Symbols>();
function symbols(analysis:GoAnalysis):Symbols {
 const cached=cache.get(analysis);if(cached)return cached;
 const types:TypeDeclaration[]=[];const files=new Map<number,GoFile>();
 for(const file of analysis.files.values()){
  files.set(file.root.id,file);
  for(const node of findAll(file.root,n=>n.type==='type_spec')){
   const name=node.childForFieldName('name')??node.namedChildren[0];
   const type=node.childForFieldName('type')??node.namedChildren.at(-1);
   if(name&&type)types.push({name:name.text,file,node,type});
  }
 }
 const result={files,types};cache.set(analysis,result);return result;
}
export function goSourceFile(node:TsNode,analysis:GoAnalysis):GoFile|undefined {
 let root=node;while(root.parent)root=root.parent;
 return symbols(analysis).files.get(root.id);
}
function packageFiles(owner:GoFile,qualifier:string|undefined,analysis:GoAnalysis):GoFile[]{
 if(!qualifier)return [...analysis.files.values()].filter(file=>dirname(file.path)===dirname(owner.path)&&file.packageName===owner.packageName);
 const imports=findAll(owner.root,n=>n.type==='import_spec').filter(n=>{
  const path=n.childForFieldName('path')??n.namedChildren.find(c=>c.type==='interpreted_string_literal');
  const alias=n.childForFieldName('name')?.text??path?.text.slice(1,-1).split('/').pop();
  return alias===qualifier;
 });
 if(imports.length!==1)return [];
 const path=imports[0]!.childForFieldName('path')??imports[0]!.namedChildren.find(c=>c.type==='interpreted_string_literal');
 const imported=path?.text.slice(1,-1);if(!imported)return [];
 const files=[...analysis.files.values()].filter(file=>{const dir=dirname(file.path).replace(/\\/g,'/');return dir!=='.'&&(imported===dir||imported.endsWith('/'+dir));});
 return new Set(files.map(file=>dirname(file.path))).size===1?files:[];
}
export function goTypeDeclaration(type:TsNode,analysis:GoAnalysis):TypeDeclaration|undefined {
 let node=type;while(node.type==='pointer_type'&&node.namedChildren[0])node=node.namedChildren[0];
 const owner=goSourceFile(node,analysis);if(!owner)return;
 const qualifier=node.type==='qualified_type'?node.namedChildren[0]?.text:undefined;
 const name=node.type==='qualified_type'?node.namedChildren[1]?.text:node.type==='type_identifier'?node.text:undefined;
 if(!name)return;
 const paths=new Set(packageFiles(owner,qualifier,analysis).map(file=>file.path));
 const candidates=symbols(analysis).types.filter(def=>def.name===name&&paths.has(def.file.path));
 return candidates.length===1?candidates[0]:undefined;
}
export function goResultType(node:TsNode,position=0):TsNode|undefined {
 const result=node.childForFieldName('result');if(!result)return;
 if(result.type!=='parameter_list')return position===0?result:undefined;
 const types=result.namedChildren.flatMap(parameter=>{
  const type=parameter.childForFieldName('type')??parameter.namedChildren.at(-1);
  const count=Math.max(1,parameter.namedChildren.filter(child=>child.type==='identifier').length);
  return type?Array.from({length:count},()=>type):[];
 });
 return types[position];
}
export function goExpressionType(node:TsNode,analysis:GoAnalysis,depth=0):TsNode|undefined {
 if(depth>12)return;
 if(node.type==='unary_expression'&&node.namedChildren[0])return goExpressionType(node.namedChildren[0],analysis,depth+1);
 if(node.type==='composite_literal')return node.childForFieldName('type')??node.namedChildren[0];
 if(node.type==='call_expression'){const fn=resolveGoCall(node,analysis,depth+1);return fn?goResultType(fn.node):undefined;}
 if(node.type==='selector_expression'){
  const receiver=node.namedChildren[0],field=node.namedChildren[1];if(!receiver||!field)return;
  const type=goExpressionType(receiver,analysis,depth+1);const def=type?goTypeDeclaration(type,analysis):undefined;
  if(def?.type.type!=='struct_type')return;
  const fields=def.type.namedChildren.find(n=>n.type==='field_declaration_list');
  return fields?.namedChildren.find(n=>n.type==='field_declaration'&&n.namedChildren.some(c=>c.type==='field_identifier'&&c.text===field.text))?.childForFieldName('type')??undefined;
 }
 if(node.type!=='identifier')return;
 let owner=node.parent;const ancestors=new Set<number>();
 while(owner&&!['function_declaration','method_declaration','func_literal'].includes(owner.type)){ancestors.add(owner.id);owner=owner.parent;}
 if(!owner)return;
 const declarations=findAll(owner,n=>['var_spec','short_var_declaration'].includes(n.type)&&n.startIndex<node.startIndex).filter(n=>{
  const names=n.type==='var_spec'?n.namedChildren.filter(c=>c.type==='identifier'):n.childForFieldName('left')?.namedChildren??[];
  // A declaration is visible only after its initializer, in its lexical scope.
  if(n.endPosition.row>node.startPosition.row||(n.endPosition.row===node.startPosition.row&&n.endPosition.column>=node.startPosition.column))return false;
  let scope=n.parent;while(scope&&scope.type!=='block')scope=scope.parent;
  return Boolean(scope&&ancestors.has(scope.id)&&names.some(c=>c.text===node.text));
 }).sort((a,b)=>b.startIndex-a.startIndex);
 const declaration=declarations[0];
 if(declaration){
  const explicit=declaration.childForFieldName('type');if(explicit)return explicit;
  const names=declaration.childForFieldName('left')?.namedChildren??declaration.namedChildren.filter(c=>c.type==='identifier');
  const pos=names.findIndex(c=>c.text===node.text);
  const values=(declaration.childForFieldName('right')??declaration.childForFieldName('value'))?.namedChildren??[];
  if(values.length===1&&values[0]?.type==='call_expression'){const fn=resolveGoCall(values[0],analysis,depth+1);return fn?goResultType(fn.node,pos):undefined;}
  return values[pos]?goExpressionType(values[pos]!,analysis,depth+1):undefined;
 }
 const lists=owner.namedChildren.filter(n=>n.type==='parameter_list'&&n.id!==owner?.childForFieldName('result')?.id);
 return lists.flatMap(list=>list.namedChildren).find(p=>p.namedChildren.some(c=>c.type==='identifier'&&c.text===node.text))?.childForFieldName('type')??undefined;
}
/**
 * Resolve a package-level function referenced as `pkg.Func` (or bare `Func`)
 * in a route registration file. The qualifier disambiguates same-named
 * functions across packages (e.g. services.CreateTodo vs dal.CreateTodo);
 * falls back to the first same-named candidate only when the package cannot
 * be resolved uniquely.
 */
export function resolveGoPackageFunction(
  analysis: GoAnalysis,
  owner: GoFile | undefined,
  qualifier: string | undefined,
  name: string,
): GoFunction | undefined {
  const candidates = analysis.functions.get(name) ?? [];
  if (candidates.length === 0) return undefined;
  if (!qualifier || !owner) return candidates[0];
  const paths = new Set(packageFiles(owner, qualifier, analysis).map((file) => file.path));
  if (paths.size === 0) return candidates[0];
  const filtered = candidates.filter((fn) => paths.has(fn.file));
  return filtered.length === 1 ? filtered[0] : (filtered[0] ?? candidates[0]);
}
export function resolveGoCall(call:TsNode,analysis:GoAnalysis,depth=0):GoFunction|undefined { if(depth>12)return;
 const callee=call.type==='call_expression'?call.namedChildren[0]:call,owner=goSourceFile(call,analysis);if(!callee||!owner)return;
 let candidates:GoFunction[]=[];
 if(callee.type==='identifier'){
  const paths=new Set(packageFiles(owner,undefined,analysis).map(file=>file.path));
  candidates=(analysis.functions.get(callee.text)??[]).filter(fn=>paths.has(fn.file));
 }else if(callee.type==='selector_expression'){
  const receiver=callee.namedChildren[0],name=callee.namedChildren[1]?.text;if(!receiver||!name)return;
  const type=goExpressionType(receiver,analysis,depth+1);
  if(type){
   const def=goTypeDeclaration(type,analysis);if(!def)return;
   if(def.type.type==='interface_type'){
    const methods=def.type.namedChildren.filter(n=>n.type==='method_spec'&&n.namedChildren[0]?.text===name);
    if(methods.length===1)return {name,file:def.file.path,node:methods[0]!,body:null,receiver:null};
    return;
   }
   candidates=analysis.methods.filter(fn=>fn.name===name&&dirname(fn.file)===dirname(def.file.path)&&fn.receiver?.namedChildren.some(p=>p.childForFieldName('type')?.text.replace(/^\*/,'')===def.name));
  }else if(receiver.type==='identifier'){
   const paths=new Set(packageFiles(owner,receiver.text,analysis).map(file=>file.path));
   candidates=(analysis.functions.get(name)??[]).filter(fn=>paths.has(fn.file));
  }
 }
 return candidates.length===1?candidates[0]:undefined;
}
