import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {JsonSchema} from '../../core/types.js';

/**
 * Minimal, dependency-free Prisma schema loader. It parses `model` and `enum`
 * blocks from a project's `schema.prisma` so ORM-backed responses can prove
 * their scalar field types without expanding relations the query did not ask
 * for. Only the fields a query selects/includes are emitted by the projection;
 * this loader never forces a whole entity onto a response.
 */

export interface PrismaModel {
 name:string;
 fields:PrismaField[];
 fieldByName:Map<string,PrismaField>;
}
export interface PrismaField {
 name:string;
 type:string;
 kind:'scalar'|'enum'|'relation';
 list:boolean;
 optional:boolean;
}
export interface PrismaSchema {
 models:Map<string,PrismaModel>;
 enums:Map<string,string[]>;
}

const SCALARS=new Set(['String','Int','BigInt','Float','Decimal','Boolean','DateTime','Json','Bytes','Decimal']);

const schemaCache=new Map<string,PrismaSchema|undefined>();
const pathCache=new Map<string,string|undefined>();

/** Locate the nearest schema.prisma above a source file. */
export function findPrismaSchemaFile(sourceFile:string|undefined):string|undefined{
 if(!sourceFile)return undefined;
 if(pathCache.has(sourceFile))return pathCache.get(sourceFile);
 let dir=dirname(sourceFile);
 let found:string|undefined;
 for(let i=0;i<12&&!found;i++){
  const candidates=[
   join(dir,'prisma','schema.prisma'),
   join(dir,'db','schema.prisma'),
   join(dir,'schema.prisma'),
   join(dir,'src','prisma','schema.prisma'),
  ];
  found=candidates.find(p=>existsSync(p));
  if(!found){
   // Also accept a single .prisma inside a prisma/ or src/prisma/ directory.
   for(const sub of ['prisma','src/prisma','db']){
    const sd=join(dir,sub);
    if(existsSync(sd)&&statSync(sd).isDirectory()){
     const hit=readdirSync(sd).find(f=>f.endsWith('.prisma'));
     if(hit){found=join(sd,hit);break;}
    }
   }
  }
  const parent=dirname(dir);
  if(parent===dir)break;
  dir=parent;
 }
 pathCache.set(sourceFile,found);
 return found;
}

function stripComments(line:string):string{
 // Prisma uses // and /// doc comments; quoted strings may contain // but field
 // declarations do not, so a simple trim is sufficient for our purposes.
 const idx=line.indexOf('//');
 return idx>=0?line.slice(0,idx):line;
}

export function parsePrismaSchema(path:string):PrismaSchema{
 const cached=schemaCache.get(path);
 if(cached)return cached;
 const text=readFileSync(path,'utf8');
 const models=new Map<string,PrismaModel>();
 const enums=new Map<string,string[]>();
 const modelRe=/^\s*model\s+([A-Za-z0-9_]+)\s*\{/;
 const enumRe=/^\s*enum\s+([A-Za-z0-9_]+)\s*\{/;
 const lines=text.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  const line=stripComments(lines[i]);
  const m=line.match(modelRe);
  const e=line.match(enumRe);
  if(m){
   const name=m[1]!;
   const body:string[]=[];
   let depth=(line.match(/\{/g)||[]).length-(line.match(/\}/g)||[]).length;
   while(i+1<lines.length&&depth>0){
    i++;
    const bl=stripComments(lines[i]!);
    depth+=(bl.match(/\{/g)||[]).length-(bl.match(/\}/g)||[]).length;
    if(depth>0)body.push(bl);
   }
   models.set(name,buildModel(name,body));
  } else if(e){
   const name=e[1]!;
   const values:string[]=[];
   let depth=(line.match(/\{/g)||[]).length-(line.match(/\}/g)||[]).length;
   while(i+1<lines.length&&depth>0){
    i++;
    const bl=stripComments(lines[i]!);
    depth+=(bl.match(/\{/g)||[]).length-(bl.match(/\}/g)||[]).length;
    if(depth>0){
     const v=bl.trim().split(/\s+/)[0];
     if(v&&!/^@@|^\/\/|^\}/.test(v))values.push(v);
    }
   }
   enums.set(name,values);
  }
 }
 const schema={models,enums};
 schemaCache.set(path,schema);
 return schema;
}

function buildModel(name:string,body:string[]):PrismaModel{
 const fields:PrismaField[]=[];
 for(const raw of body){
  const line=raw.trim();
  if(!line||line.startsWith('@@')||line.startsWith('//'))continue;
  // fieldName Type?[] @attributes...
  const match=line.match(/^([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?/);
  if(!match)continue;
  const [,fieldName,type,listTok,optTok]=match;
  if(!fieldName||!type)continue;
  let kind:PrismaField['kind']='scalar';
  if(SCALARS.has(type))kind='scalar';
  else if(/^[A-Z]/.test(type))kind='relation'; // refined to enum below
  fields.push({name:fieldName,type,kind,list:!!listTok,optional:!!optTok});
 }
 const fieldByName=new Map(fields.map(f=>[f.name,f]));
 return {name,fields,fieldByName};
}

/** Resolve enum vs relation kinds once all blocks are parsed. */
export function finalizeKinds(schema:PrismaSchema):void{
 for(const model of schema.models.values()){
  for(const f of model.fields){
   if(f.kind==='relation'&&schema.enums.has(f.type))f.kind='enum';
  }
 }
}

export function loadPrismaSchema(sourceFile:string|undefined):PrismaSchema|undefined{
 const path=findPrismaSchemaFile(sourceFile);
 if(!path)return undefined;
 try{
  const schema=parsePrismaSchema(path);
  finalizeKinds(schema);
  return schema;
 }catch{
  return undefined;
 }
}

/** Map a Prisma delegate property name (prisma.article) to its model (Article). */
export function delegateToModelName(delegate:string):string{
 return delegate.charAt(0).toUpperCase()+delegate.slice(1);
}

function scalarSchema(type:string):JsonSchema{
 switch(type){
  case 'String':return {type:'string'};
  // Prisma Int/BigInt reach JavaScript/TypeScript as `number` (the language has
  // no int type), and the independent API contracts use `number`; emit number
  // rather than the narrower OpenAPI `integer`.
  case 'Int':case 'BigInt':case 'Float':case 'Decimal':return {type:'number'};
  case 'Boolean':return {type:'boolean'};
  case 'DateTime':return {type:'string',format:'date-time'};
  case 'Json':return {};
  case 'Bytes':return {type:'string',contentEncoding:'base64'};
  default:return {};
 }
}

/** JSON schema for a single model field, given the whole schema for relations.
 * Relations are expanded only one level (scalar fields of the target model);
 * nested relation keys carry an x-prisma-model marker instead of recursing, so
 * self-referential models (User.followedBy -> User[]) cannot overflow. Deeper
 * shapes are resolved by the projection when a query explicitly selects them. */
export function prismaFieldSchema(field:PrismaField,schema:PrismaSchema):JsonSchema{
 let base:JsonSchema;
 if(field.kind==='enum'){
  const values=schema.enums.get(field.type);
  base=values?{type:'string',enum:[...values]}:{type:'string'};
 } else if(field.kind==='relation'){
  base=relationShallow(field.type,schema,new Set([field.type]));
 } else {
  base=scalarSchema(field.type);
 }
 if(field.list){
  return {type:'array',items:base};
 }
 if(field.optional){
  const types=Array.isArray(base.type)?base.type:[base.type];
  return {...base,type:[...types,'null']} as JsonSchema;
 }
 return base;
}

/** One-level expansion of a relation: scalars of the target model, with any
 * relation keys left as model markers to prevent cycles. */
function relationShallow(modelName:string,schema:PrismaSchema,seen:Set<string>):JsonSchema{
 const model=schema.models.get(modelName);
 if(!model)return {};
 const props:Record<string,JsonSchema>={};
 const required:string[]=[];
 for(const tf of model.fields){
  if(tf.kind==='relation'){
   // Do not recurse. Mark the target model; list/nullability still encoded.
   const marker:JsonSchema=tf.list?{type:'array',items:{['x-prisma-model' as any]:tf.type}}:{['x-prisma-model' as any]:tf.type};
   props[tf.name]=marker;
  } else {
   props[tf.name]=scalarSchema(tf.type);
  }
  // Prisma emits each scalar/relation key; optionality only nulls the value.
  required.push(tf.name);
 }
 return {type:'object',properties:props,required,['x-prisma-model' as any]:modelName};
}
