/** Bounded source evaluation for inherited PSR response actions.
 * Unknown control flow never supplies a fabricated response contract.
 */
import type {DiscoveredResponse, JsonSchema} from '../core/types.js';
import type {PhpClass} from '../lang/php/index.js';
import {findPhpMethod, phpStringText, resolvePhpClass} from '../lang/php/index.js';
import {formalParameters, ensurePhpResponseComponent, type PhpModelIndex} from '../lang/php/schema.js';
import {declaredPhpMethodSchema} from '../lang/php/response.js';
import {findAll} from '../lang/treesitter/ast.js';
import type {TsNode} from '../lang/treesitter/runtime.js';

type Value = {schema: JsonSchema; literal?: string | number | boolean | null; cls?: PhpClass;
 fields?: Map<string,Value>; response?: DiscoveredResponse; stream?: DiscoveredResponse; encoded?: JsonSchema};
const unknown = ():Value => ({schema:{}});

export function slimActionResponse(cls:PhpClass,model:PhpModelIndex): {response:DiscoveredResponse; uncertain:boolean}|undefined {
 let steps=0, uncertain=false;
 const active=new Set<string>();
 const instance:Value={schema:{},cls,fields:new Map()};
 function args(node:TsNode):TsNode[]{return node.namedChildren.find(child=>child.type==='arguments')?.namedChildren.map(child=>child.type==='argument'?child.namedChildren[0]!:child)??[];}
 function schemaOf(value:Value,depth:number):JsonSchema {
  if(depth>64)return {};
  if(value.cls&&value.fields?.size&&findPhpMethod(value.cls,'jsonSerialize',model.analysis)){
   const serialized=invoke(value,'jsonSerialize',[],depth+1);
   return serialized?.schema??{};
  }
  return value.schema;
 }
 function nullness(value:Value):boolean|undefined {
  if(value.literal===null||value.schema.type==='null')return true;
  if(value.literal!==undefined)return false;
  if(value.cls)return false; // A reference can resolve to a nullable schema.
  let schema=value.schema;
  const seen=new Set<string>();
  while(typeof schema.$ref==='string'&&schema.$ref.startsWith('#/components/schemas/')){
   const ref=schema.$ref;if(seen.has(ref)||seen.size>=32)return undefined;seen.add(ref);
   const target=model.components.get(ref.slice('#/components/schemas/'.length));if(!target)return undefined;schema=target;
  }
  const types=Array.isArray(schema.type)?schema.type:[schema.type];
  return types[0]&&!types.includes('null')?false:undefined;
 }
 function expression(node:TsNode|undefined,env:Map<string,Value>,self:Value,method:TsNode,depth:number):Value {
  if(!node||depth>64||++steps>2000)return unknown();
  if(node.type==='argument'||node.type==='parenthesized_expression')return expression(node.namedChildren[0],env,self,method,depth+1);
  if(node.type==='variable_name')return node.text==='$this'?self:env.get(node.text)??unknown();
  if(node.type==='null')return {schema:{type:'null'},literal:null};
  if(node.type==='integer')return {schema:{type:'integer'},literal:Number(node.text)};
  if(node.type==='string')return {schema:{type:'string'},literal:phpStringText(node)??undefined};
  if(node.type==='boolean')return {schema:{type:'boolean'},literal:node.text==='true'};
  if(node.type==='member_access_expression')return expression(node.namedChildren[0],env,self,method,depth+1).fields?.get(node.namedChildren.at(-1)?.text??'')??unknown();
  if(node.type==='binary_expression'){
   const [left,right]=node.namedChildren;
   const operator=node.children.find(child=>['!==','===','!=','=='].includes(child.text))?.text;
   if(operator&&left&&right){
    if(operator==='=='||operator==='!=')return unknown();
    const a=expression(left,env,self,method,depth+1),b=expression(right,env,self,method,depth+1);
    const equal=b.literal===null?nullness(a):a.literal===null?nullness(b):a.literal!==undefined&&b.literal!==undefined?a.literal===b.literal:undefined;
    if(equal!==undefined)return {schema:{type:'boolean'},literal:operator.startsWith('!')?!equal:equal};
   }
   return unknown();
  }
  if(node.type==='array_creation_expression'){
   const properties:Record<string,JsonSchema>={};
   const entries=node.namedChildren.filter(child=>child.type==='array_element_initializer');
   if(!entries.length)return {schema:{type:'array',items:{}}};
   for(const entry of entries){
    const [key,value]=entry.namedChildren;
    if(key?.type!=='string'||!value)return unknown();
    properties[phpStringText(key)!]=schemaOf(expression(value,env,self,method,depth+1),depth+1);
   }
   return {schema:{type:'object',properties,required:Object.keys(properties)}};
  }
  if(node.type==='assignment_expression'){
   const [left,right]=node.namedChildren;if(!left)return unknown();
   const value=expression(right,env,self,method,depth+1);
   if(left.type==='variable_name')env.set(left.text,value);
   else if(left.type==='member_access_expression')expression(left.namedChildren[0],env,self,method,depth+1).fields?.set(left.namedChildren.at(-1)?.text??'',value);
   else if(left.type==='subscript_expression'){
    const target=expression(left.namedChildren[0],env,self,method,depth+1);
    const key=left.namedChildren[1];const name=key?.type==='string'?phpStringText(key):null;
    if(name!==null&&target.schema.type==='object'){
     const properties=target.schema.properties as Record<string,JsonSchema>;properties[name]=schemaOf(value,depth+1);
     target.schema.required=[...new Set([...(target.schema.required as string[]??[]),name])];
    }
   }
   return value;
  }
  if(node.type==='object_creation_expression'){
   const name=node.namedChildren.find(child=>['name','qualified_name'].includes(child.type));
   const created=name?resolvePhpClass(name.text,model.analysis,name):undefined;
   if(!created)return unknown();
   const value:Value={schema:ensurePhpResponseComponent(created.fqcn,model)??{},cls:created,fields:new Map()};
   invoke(value,'__construct',args(node).map(arg=>expression(arg,env,self,method,depth+1)),depth+1);
   return value;
  }
  if(node.type==='function_call_expression'){
   const callee=node.namedChildren[0];
   if(callee?.text==='json_encode'){
    const shadowed=[...model.analysis.files.values()].some(file=>findAll(file.root,n=>n.type==='function_definition'&&n.namedChildren.find(child=>child.type==='name')?.text==='json_encode').length);
    if(!shadowed){const value=expression(args(node)[0],env,self,method,depth+1);return {schema:{type:'string'},encoded:schemaOf(value,depth+1)};}
   }
   return unknown();
  }
  if(node.type==='member_call_expression'){
   const receiver=expression(node.namedChildren[0],env,self,method,depth+1);
   const name=node.namedChildren.find(child=>child.type==='name')?.text??'';
   const values=args(node).map(arg=>expression(arg,env,self,method,depth+1));
   if(receiver.cls){const result=invoke(receiver,name,values,depth+1);if(result)return result;}
   if(receiver.response){
    if(name==='getBody')return {schema:{},stream:receiver.response};
    if(name==='withHeader'){
     if(String(values[0]?.literal).toLowerCase()==='content-type'&&typeof values[1]?.literal==='string'){
      const copy=structuredClone(receiver.response);copy.content=(copy.content?.length?copy.content:[{mediaType:values[1].literal,schema:{}}]).map(content=>({...content,mediaType:values[1]!.literal as string}));
      return {schema:{},response:copy};
     }
     return receiver;
    }
    if(name==='withStatus')return {schema:{},response:{...receiver.response,statusCode:typeof values[0]?.literal==='number'?String(values[0].literal):'default'}};
   }
   if(receiver.stream&&name==='write'){
    receiver.stream.content=[{mediaType:'*/*',schema:values[0]?.encoded??values[0]?.schema??{}}];
    return unknown();
   }
   const schema=declaredPhpMethodSchema(node,model,method);
   return {schema:schema??{}};
  }
  return unknown();
 }
 function execute(body:TsNode,env:Map<string,Value>,self:Value,method:TsNode,depth:number):{returned:boolean;value:Value}|undefined {
  if(depth>64||++steps>2000){uncertain=true;return {returned:true,value:unknown()};}
  for(const statement of body.namedChildren){
   if(statement.type==='return_statement')return {returned:true,value:expression(statement.namedChildren[0],env,self,method,depth+1)};
   if(statement.type==='expression_statement')expression(statement.namedChildren[0],env,self,method,depth+1);
   else if(statement.type==='if_statement'){
    const condition=expression(statement.namedChildren[0],env,self,method,depth+1).literal;
    if(typeof condition!=='boolean'){uncertain=true;return {returned:true,value:unknown()};}
    let block:TsNode|undefined;
    if(condition)block=statement.namedChildren.find(child=>child.type==='compound_statement');
    else for(const branch of statement.namedChildren.filter(child=>child.type==='else_clause'||child.type==='else_if_clause')){
     if(branch.type==='else_if_clause'){
      const next=expression(branch.namedChildren[0],env,self,method,depth+1).literal;
      if(typeof next!=='boolean'){uncertain=true;return {returned:true,value:unknown()};}
      if(!next)continue;
     }
     block=branch.namedChildren.find(child=>child.type==='compound_statement');break;
    }
    const result=block?execute(block,env,self,method,depth+1):undefined;if(result?.returned)return result;
   }else if(statement.type==='try_statement'){
    // Finally may replace a return or mutate the shared body stream. Until it
    // is evaluated, no success contract can safely escape this block.
    if(statement.namedChildren.some(child=>child.type==='finally_clause')){uncertain=true;return {returned:true,value:unknown()};}
    uncertain=true; // Success flow only; catches require separate exception evidence.
    const block=statement.namedChildren.find(child=>child.type==='compound_statement');
    const result=block?execute(block,env,self,method,depth+1):undefined;if(result?.returned)return result;
   }else if(!['comment','text_interpolation'].includes(statement.type)){
    uncertain=true;return {returned:true,value:unknown()};
   }
  }
  return undefined;
 }
 function invoke(self:Value,name:string,values:Value[],depth:number):Value|undefined {
  if(!self.cls||depth>64)return undefined;
  const method=findPhpMethod(self.cls,name,model.analysis);if(!method)return undefined;
  const key=`${self.cls.fqcn}:${name}`;if(active.has(key)){uncertain=true;return undefined;}
  const body=method.namedChildren.find(child=>child.type==='compound_statement');if(!body)return undefined;
  active.add(key);
  try{
   const env=new Map<string,Value>();
   formalParameters(method).forEach((param,index)=>{
    const variable=param.namedChildren.find(child=>child.type==='variable_name');if(!variable)return;
    const fallback=param.children.some(child=>child.text==='=')?param.namedChildren.at(-1):undefined;
    env.set(variable.text,values[index]??expression(fallback,env,self,method,depth+1));
   });
   return execute(body,env,self,method,depth+1)?.value;
  }finally{active.delete(key);}
 }
 const response:DiscoveredResponse={statusCode:'200',description:'',confidence:'medium'};
 const value=invoke(instance,'__invoke',[unknown(),{schema:{},response},unknown()],0);
 return value?.response?{response:value.response,uncertain}:undefined;
}
