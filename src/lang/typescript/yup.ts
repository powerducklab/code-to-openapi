import type {TsAnalysis} from './index.js';
import type {JsonSchema} from '../../core/types.js';
import {resolveStaticValue} from './staticValue.js';
interface Field {schema:JsonSchema;required?:boolean;hasDefault?:boolean;defaultValue?:unknown;defined?:boolean;defaultKnown?:boolean;nullable?:boolean}
export interface YupOptions {mode:'input'|'output';context?:Record<string,unknown>;warnings:Set<string>}
/** Static Yup subset. Custom tests/transforms remain explicit review gaps. */
export function yupSchema(analysis:TsAnalysis,node:any,options:YupOptions):JsonSchema|undefined {
 const {ts}=analysis;
 const literal=(n:any):unknown=>!n?undefined:ts.isStringLiteralLike(n)?n.text:ts.isNumericLiteral(n)?Number(n.text):n.kind===ts.SyntaxKind.TrueKeyword?true:n.kind===ts.SyntaxKind.FalseKeyword?false:undefined;
 const property=(object:any,key:string)=>object&&ts.isObjectLiteralExpression(object)?object.properties.find((p:any)=>ts.isPropertyAssignment(p)&&p.name.text===key)?.initializer:undefined;
 const defaultValid=(field:Field)=>{
  if(!field.hasDefault||!field.defaultKnown)return false;
  const value=field.defaultValue,schema=field.schema;
  if(schema.type==='string')return typeof value==='string'&&(!field.required||field.defined||value.length>0)&&value.length>=Number(schema.minLength??0)&&value.length<=Number(schema.maxLength??Infinity)&&!schema.format;
  if(schema.type==='number')return typeof value==='number'&&value>=Number(schema.minimum??-Infinity)&&value<=Number(schema.maximum??Infinity);
  return schema.type==='boolean'&&typeof value==='boolean';
 };
 const materialize=(field:Field):JsonSchema=>field.nullable&&!field.required?{anyOf:[field.schema,{type:'null'}]}:field.schema;
 const needs=(field:Field)=>options.mode==='output'?!!field.required||!!field.defaultKnown:!!field.required&&!defaultValid(field);
 const parse=(value:any,seen:Set<any>,depth:number):Field|undefined=>{
  if(!value||depth>24||seen.has(value))return;
  const next=new Set(seen).add(value);
  const resolved=resolveStaticValue(analysis,value);
  if(resolved&&resolved!==value)return parse(resolved,next,depth+1);
  if(!ts.isCallExpression(value)||!ts.isPropertyAccessExpression(value.expression))return;
  const name=value.expression.name.text, receiver=value.expression.expression, args=value.arguments;
  const root=resolveStaticValue(analysis,receiver);
  if(root&&ts.isCallExpression(root)&&ts.isIdentifier(root.expression)&&root.expression.text==='require'&&root.arguments[0]&&ts.isStringLiteralLike(root.arguments[0])&&root.arguments[0].text==='yup'){
   if(['string','number','boolean','array','object'].includes(name)){
    const schema:JsonSchema={type:name};
    if(args.length){
     if(name==='object'&&args[0]&&ts.isObjectLiteralExpression(args[0])){
      const properties:Record<string,JsonSchema>={},required:string[]=[];
      for(const prop of args[0].properties){
       if(!ts.isPropertyAssignment(prop)||!prop.name.text){options.warnings.add('Dynamic Yup object constructor');return {schema:{}};}
       const child=parse(prop.initializer,next,depth+1);properties[prop.name.text]=child?materialize(child):{};
       if(child&&needs(child))required.push(prop.name.text);
      }schema.properties=properties;if(required.length)schema.required=required;
     }else if(name==='array'){const child=parse(args[0],next,depth+1);schema.items=child?materialize(child):{};}
     else {options.warnings.add('Unsupported Yup constructor arguments');return {schema:{}};}
    }
    return {schema};
   }
   return;
  }
  const base=parse(receiver,next,depth+1);if(!base)return;
  const field:Field={...base,schema:{...base.schema}};
  if(name==='shape'&&field.schema.type==='object'&&args[0]&&ts.isObjectLiteralExpression(args[0])){
   const properties:Record<string,JsonSchema>={...(field.schema.properties as Record<string,JsonSchema>??{})};
   const required=new Set(field.schema.required as string[]??[]);
   for(const prop of args[0].properties){
    if(!ts.isPropertyAssignment(prop)||!prop.name.text){options.warnings.add('Dynamic Yup shape member');continue;}
    const child=parse(prop.initializer,next,depth+1);
    properties[prop.name.text]=child?materialize(child):{};
    if(child&&needs(child))required.add(prop.name.text);else required.delete(prop.name.text);
   }
   field.schema={type:'object',properties,...(required.size?{required:[...required]}:{})};
  }else if(name==='concat'){
   const other=parse(args[0],next,depth+1);if(!other)return;
   if(field.schema.type==='object'&&other.schema.type==='object'){
    const replaced=new Set(Object.keys(other.schema.properties??{}));
    const required=[...new Set([...(field.schema.required as string[]??[]).filter(k=>!replaced.has(k)),...(other.schema.required as string[]??[])])];
    field.schema={...field.schema,properties:{...(field.schema.properties as object),...(other.schema.properties as object)}};
    if(required.length)field.schema.required=required;else delete field.schema.required;
   }else field.schema={...field.schema,...other.schema};
  }else if(name==='required'||name==='defined'){field.required=true;field.defined=name==='defined';}
  else if(name==='notRequired'||name==='optional')field.required=false;
  else if(name==='default'){
   field.hasDefault=true;field.defaultValue=literal(args[0]);field.defaultKnown=field.defaultValue!==undefined;
   const body=args[0]&&ts.isArrowFunction(args[0])?args[0].body:undefined;
   if(body&&ts.isCallExpression(body)&&ts.isPropertyAccessExpression(body.expression)&&body.expression.name.text==='toISOString'&&ts.isNewExpression(body.expression.expression)&&body.expression.expression.expression.getText()==='Date'&&!(analysis.checker.getSymbolAtLocation(body.expression.expression.expression)?.declarations??[]).some((d:any)=>analysis.isProjectFile(d.getSourceFile().fileName))){field.defaultKnown=true;field.defaultValue='1970-01-01T00:00:00.000Z';}
   if(!field.defaultKnown)options.warnings.add('Unresolved Yup default producer');
  }
  else if(name==='nullable'){field.nullable=literal(args[0])!==false;if(field.required&&field.nullable)options.warnings.add('Yup required/nullable ordering is version-dependent');}
  else if(name==='email')field.schema.format='email';
  else if(name==='url')field.schema.format='uri';
  else if((name==='min'||name==='max')&&typeof literal(args[0])==='number'){
   const key=field.schema.type==='string'?(name==='min'?'minLength':'maxLength'):field.schema.type==='array'?(name==='min'?'minItems':'maxItems'):(name==='min'?'minimum':'maximum');field.schema[key]=literal(args[0]);
  }else if(name==='of'&&field.schema.type==='array'){const child=parse(args[0],next,depth+1);field.schema.items=child?materialize(child):{};}
  else if(name==='when'){
   const key=literal(args[0]);const condition=literal(property(args[1],'is'));
   if(typeof key!=='string'||!key.startsWith('$')||!options.context||!(key.slice(1) in options.context)){options.warnings.add('Unresolved contextual Yup condition');return {schema:{}};}
   const branch=property(args[1],options.context[key.slice(1)]===condition?'then':'otherwise');
   if(branch)return parse(branch,next,depth+1)??{schema:{}};
  }else if(['test','transform'].includes(name))options.warnings.add('Custom Yup validation or transform requires review');
  else if(!['trim','lowercase','uppercase','noUnknown','label','meta','strict'].includes(name)){options.warnings.add(`Unsupported Yup operation: ${name}`);return {schema:{}};}
  return field;
 };
 const result=parse(node,new Set(),0);return result?materialize(result):undefined;
}
