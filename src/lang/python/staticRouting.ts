import type {PythonAnalysis} from './index.js';
import type {TsNode} from '../treesitter/runtime.js';
import {findAll} from '../treesitter/ast.js';
import {pythonBindingResolver} from './symbols.js';

function scopeOf(node: TsNode): TsNode {
 let scope = node.parent;
 while(scope?.parent && !['function_definition','class_definition','lambda'].includes(scope.type)) scope = scope.parent;
 return scope ?? node;
}

/** Prove inheritance from an imported framework class, without name guessing. */
export function pythonFrameworkSubclass(analysis:PythonAnalysis,file:string,reference:TsNode,module:string,name:string,seen=new Set<string>()):boolean {
 const key=`${file}:${reference.text}`;
 if(seen.has(key)||seen.size>24)return false;
 const next=new Set(seen).add(key);
 const parts=reference.text.split('.');
 const imported=analysis.files.get(file)?.imports.get(parts[0]!);
 if(imported && (parts.length===1 ? imported.module===module && imported.importedName===name : parts.length===2 && imported.module===module && parts[1]===name))return true;
 const symbol=pythonBindingResolver(analysis).resolve(file,reference.text);
 if(!symbol)return false;
 const classes=analysis.classes.filter(cls=>cls.file===symbol.file&&cls.name===symbol.name);
 return classes.length===1&&classes[0]!.bases.some(base=>pythonFrameworkSubclass(analysis,symbol.file,base,module,name,next));
}

/** Expand only literal iterable bindings (including imported starred lists). */
export function pythonStaticIterableElements(analysis:PythonAnalysis,file:string,node:TsNode,seen=new Set<string>()):Array<{file:string;node:TsNode}>|null {
 const key=`${file}:${node.id}`;
 if(seen.has(key)||seen.size>24)return null;
 const next=new Set(seen).add(key);
 if(['list','tuple'].includes(node.type)){
  const result:Array<{file:string;node:TsNode}>=[];
  for(const child of node.namedChildren){
   if(child.type==='comment')continue;
   if(child.type==='list_splat'){
    const nested=child.namedChildren[0];
    const expanded=nested?pythonStaticIterableElements(analysis,file,nested,next):null;
    if(!expanded)return null;
    result.push(...expanded);
   }else result.push({file,node:child});
  }
  return result;
 }
 if(node.type!=='identifier')return null;
 const scope=scopeOf(node);
 let definitions=findAll(analysis.files.get(file)?.root,n=>n.type==='assignment'&&n.namedChildren[0]?.text===node.text&&scopeOf(n).id===scope.id&&n.startIndex<node.startIndex);
 let owner=file;
 if(!definitions.length){
  const symbol=pythonBindingResolver(analysis).resolve(file,node.text);
  if(!symbol||symbol.file===file&&symbol.name===node.text)return null;
  owner=symbol.file;
  definitions=findAll(analysis.files.get(owner)?.root,n=>n.type==='assignment'&&n.namedChildren[0]?.text===symbol.name&&scopeOf(n).type==='module');
 }
 if(definitions.length!==1)return null;
 const value=definitions[0]!.namedChildren.at(-1);
 return value?pythonStaticIterableElements(analysis,owner,value,next):null;
}
