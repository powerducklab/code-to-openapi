import type {PythonAnalysis, PyFunction} from './index.js';
import type {TsNode} from '../treesitter/runtime.js';
import {findAll, childrenOfType} from '../treesitter/ast.js';
import {pythonBindingResolver} from './symbols.js';
import {buildComponent, type ModelIndex} from './schema.js';
import type {JsonSchema} from '../../core/types.js';

/** A Pydantic constructor proves a body only when its sole input is the
 * unmodified JSON request. Constants, service results and injected fields are
 * deliberately not treated as HTTP parameters. */
export function validatedJsonBody(analysis:PythonAnalysis, fn:PyFunction, index:ModelIndex):JsonSchema|undefined {
 if(!fn.body)return;
 const imports=analysis.files.get(fn.file)?.imports;
 const inHandler=(node:TsNode)=>{
  for(let parent=node.parent;parent&&parent.id!==fn.node.id;parent=parent.parent)
   if(parent.type==='function_definition'||parent.type==='lambda')return false;
  return true;
 };
 const nodes=findAll(fn.body,n=>['assignment','call','subscript','delete_statement','augmented_assignment'].includes(n.type)).filter(inHandler);
 const jsonInput=(n:TsNode|undefined):boolean=>{
  if(!n)return false;
  const text=n.text.replace(/\s/g,'');
  for(const [name,binding] of imports??[]) {
   if(binding.module!=='flask')continue;
   const receiver=binding.importedName==='request'?name:binding.importedName===null?`${name}.request`:undefined;
   if(receiver&&(text===`${receiver}.get_json()`||text===`${receiver}.json`))return true;
  }
  return false;
 };
 const fromJson=(node:TsNode|undefined):boolean=>{
  if(jsonInput(node))return true;
  if(node?.type!=='identifier')return false;
  const assignments=nodes.filter(n=>n.type==='assignment'&&n.namedChildren[0]?.text===node.text);
  if(assignments.length!==1||assignments[0]!.startIndex>=node.startIndex||!jsonInput(assignments[0]!.namedChildren.at(-1)))return false;
  // Any other write or escape may have changed the data before validation.
  const between=nodes.filter(n=>n.startIndex>assignments[0]!.endIndex&&n.endIndex<node.startIndex);
  return !between.some(n=>
   (['assignment','augmented_assignment','delete_statement'].includes(n.type)&&n.text.includes(node.text))||
   (n.type==='call'&&n.endIndex<node.startIndex&&
    findAll(n,c=>c.type==='identifier'&&c.text===node.text).length>0));
 };
 const resolve=pythonBindingResolver(analysis);
 const schemas:JsonSchema[]=[];
 for(const call of nodes.filter(n=>n.type==='call')){
  const args=childrenOfType(call,'argument_list')[0]?.namedChildren??[];
  if(args.length!==1||args[0]?.type!=='dictionary_splat'||!fromJson(args[0].namedChildren[0]))continue;
  const name=call.namedChildren[0]?.text;
  const binding=name&&resolve.resolve(fn.file,name);
  if(!binding)continue;
  const cls=analysis.classes.find(c=>c.file===binding.file&&c.name===binding.name);
  if(!cls||!index.pydanticNames.has(cls.name)||analysis.classes.filter(c=>c.name===cls.name).length!==1)continue;
  const component=buildComponent(cls,index);
  if(component)schemas.push(component.schema);
 }
 const unique=[...new Map(schemas.map(s=>[JSON.stringify(s),s])).values()];
 return unique.length===1?unique[0]:undefined;
}
