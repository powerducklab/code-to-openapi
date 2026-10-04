import type {TsAnalysis} from './index.js';
import type {JsonSchema} from '../../core/types.js';
import {loadPrismaSchema,delegateToModelName,prismaFieldSchema,type PrismaSchema,type PrismaModel,type PrismaField} from './prismaSchema.js';

/**
 * Project a Prisma client call (findMany/findUnique/findFirst/create/update/
 * upsert) into the JSON schema it actually returns.
 *
 * Prisma semantics:
 *  - no `select`/`include`: every scalar field of the model is returned, no
 *    relations.
 *  - `select`: a whitelist; only the listed scalar/relation keys are returned.
 *  - `include`: all scalar fields plus the listed relations.
 * Scalar types come from the parsed schema.prisma. Relations are expanded only
 * to a bounded depth to avoid cycles; a nested `select` narrows precisely.
 */
export function prismaProjection(analysis:TsAnalysis,node:any):JsonSchema|undefined {
 const {ts}=analysis;
 if(!ts.isCallExpression(node)||!ts.isPropertyAccessExpression(node.expression))return;
 const method=node.expression.name.text;
 if(!['findUnique','findFirst','findUniqueOrThrow','findFirstOrThrow','create','update','upsert','findMany','count'].includes(method))return;
 const delegate=node.expression.expression;
 if(!ts.isPropertyAccessExpression(delegate))return;
 const importedClient=(name:any)=>{
  const symbol=analysis.checker.getSymbolAtLocation(name);
  return (symbol?.declarations??[]).some((d:any)=>ts.isImportSpecifier(d)&&(d.propertyName?.text??d.name.text)==='PrismaClient'&&d.parent?.parent?.parent?.moduleSpecifier?.text==='@prisma/client');
 };
 const isClient=(value:any,seen=new Set<any>(),depth=0):boolean=>{
  if(!value||depth>12||seen.has(value))return false;
  const next=new Set(seen).add(value);
  if(ts.isNewExpression(value))return importedClient(value.expression);
  if(ts.isBinaryExpression(value)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind))return isClient(value.left,next,depth+1)&&isClient(value.right,next,depth+1);
  let symbol=analysis.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(value)?value.name:value);
  if(symbol?.flags&ts.SymbolFlags.Alias)symbol=analysis.checker.getAliasedSymbol(symbol);
  return (symbol?.declarations??[]).some((d:any)=>{
   if(d.type&&ts.isTypeReferenceNode(d.type)&&importedClient(d.type.typeName))return true;
   if(ts.isVariableDeclaration(d)&&d.initializer)return isClient(d.initializer,next,depth+1);
   if(ts.isExportAssignment(d))return isClient(d.expression,next,depth+1);
   return false;
  });
 };
 if(!isClient(delegate.expression))return;
 // Aggregate count returns a number regardless of selection.
 if(method==='count')return {type:'number'};

 const sourceFile=node.getSourceFile()?.fileName;
 const schema=loadPrismaSchema(sourceFile);
 const modelName=delegateToModelName(delegate.name.text);
 const model=schema?.models.get(modelName);

 const options=node.arguments[0];
 const hasOptions=options&&ts.isObjectLiteralExpression(options);
 const option=(name:string)=>hasOptions?options.properties.find((p:any)=>ts.isPropertyAssignment(p)&&(p.name.text??'')===name)?.initializer:undefined;
 const selection=option('select');
 const inclusion=option('include');

 const properties:Record<string,JsonSchema>={};
 const required:string[]=[];
 const add=(name:string,schemaValue:JsonSchema,isRequired:boolean)=>{
  properties[name]=schemaValue;
  if(isRequired)required.push(name);
 };

 // Scalar fields of the root model. Without a `select` these are all returned.
 // Prisma always emits every selected scalar key; an optional (`String?`) field
 // is nullable in value (its type includes `null`), not missing as a key, so it
 // stays required. Nullability is encoded by prismaFieldSchema, not required.
 const scalarProps=(m:PrismaModel)=>{
  for(const f of m.fields){
   if(f.kind==='relation')continue;
   add(f.name,prismaFieldSchema(f,schema!),true);
  }
 };

 if(model&&schema){
  if(selection&&ts.isObjectLiteralExpression(selection)){
  // Whitelist: only selected keys, each narrowed exactly as written.
  for(const field of selection.properties){
   if(!ts.isPropertyAssignment(field)||!(ts.isIdentifier(field.name)||ts.isStringLiteralLike(field.name)))continue;
   const fname=field.name.text;
   if(field.initializer.kind===ts.SyntaxKind.FalseKeyword)continue;
   const mf=model.fieldByName.get(fname);
   if(field.initializer.kind===ts.SyntaxKind.TrueKeyword){
    if(mf){add(fname,prismaFieldSchema(mf,schema),true);}
    else add(fname,{},true);
    continue;
   }
   const nested=nestedSelection(field.initializer,mf,schema,ts,0);
   if(nested!==undefined)add(fname,nested,true);
  }
  } else {
  // Default scalars, plus explicit includes.
  scalarProps(model);
  if(inclusion&&ts.isObjectLiteralExpression(inclusion)){
   for(const field of inclusion.properties){
    if(!ts.isPropertyAssignment(field)||!(ts.isIdentifier(field.name)||ts.isStringLiteralLike(field.name)))continue;
    const fname=field.name.text;
    if(fname==='_count'){
     const countSchema=buildCount(field.initializer,ts);
     if(countSchema)add(fname,countSchema,true);
     continue;
    }
    const mf=model.fieldByName.get(fname);
    if(field.initializer.kind===ts.SyntaxKind.FalseKeyword)continue;
    if(field.initializer.kind===ts.SyntaxKind.TrueKeyword){
     if(mf)add(fname,relationFull(mf,schema,0),true);
     continue;
    }
    const nested=nestedSelection(field.initializer,mf,schema,ts,0);
    if(nested!==undefined)add(fname,nested,true);
   }
  }
  }
 } else {
  // Schema unavailable: fall back to the old structural behavior for explicit
  // select/include so we still prove returned keys without fabricating types.
  if(selection&&ts.isObjectLiteralExpression(selection)){
   for(const field of selection.properties){
    if(!ts.isPropertyAssignment(field)||!(ts.isIdentifier(field.name)||ts.isStringLiteralLike(field.name)))continue;
    if(field.initializer.kind===ts.SyntaxKind.FalseKeyword)continue;
    if(field.initializer.kind===ts.SyntaxKind.TrueKeyword){add(field.name.text,{},true);continue;}
    const nested=nestedSelection(field.initializer,undefined,undefined,ts,0);
    if(nested!==undefined)add(field.name.text,nested,true);
   }
  } else if(inclusion&&ts.isObjectLiteralExpression(inclusion)){
   for(const field of inclusion.properties){
    if(!ts.isPropertyAssignment(field)||!(ts.isIdentifier(field.name)||ts.isStringLiteralLike(field.name)))continue;
    const fname=field.name.text;
    if(fname==='_count'){const c=buildCount(field.initializer,ts);if(c)add(fname,c,true);continue;}
    if(field.initializer.kind===ts.SyntaxKind.TrueKeyword){add(fname,{},true);continue;}
    const nested=nestedSelection(field.initializer,undefined,undefined,ts,0);
    if(nested!==undefined)add(fname,nested,true);
   }
  } else {
   // No schema and no selection: cannot prove the payload without fabricating.
   return undefined;
  }
 }

 const object:JsonSchema={type:'object',properties,required};
 if(method==='findMany')return {type:'array',items:object};
 if(['findUnique','findFirst','findUniqueOrThrow','findFirstOrThrow'].includes(method))return {anyOf:[object,{type:'null'}]};
 return object;
}

/** Full relation for `include: { rel: true }`, expanded to a bounded depth. */
function relationFull(field:PrismaField,schema:PrismaSchema,depth:number):JsonSchema{
 const target=schema.models.get(field.type);
 if(!target)return field.list?{type:'array',items:{}}:{};
 if(depth>=1){
  // Bound recursion: mark the model but do not re-expand its relations.
  const shallow=shallowModel(target,schema);
  return field.list?{type:'array',items:shallow}:shallow;
 }
 const props:Record<string,JsonSchema>={};
 const required:string[]=[];
 for(const tf of target.fields){
  if(tf.kind==='relation'){
   props[tf.name]=relationFull(tf,schema,depth+1);
  } else {
   props[tf.name]=prismaFieldSchema(tf,schema);
  }
  // Included relation keys are present in the payload; optionality only makes
  // the value nullable (encoded in the type), not the key missing.
  required.push(tf.name);
 }
 const obj:JsonSchema={type:'object',properties:props,required,['x-prisma-model' as any]:target.name};
 return field.list?{type:'array',items:obj}:obj;
}

/** Scalar-only shape of a model; relation keys stay open to stop cycles. */
function shallowModel(model:PrismaModel,schema:PrismaSchema):JsonSchema{
 const props:Record<string,JsonSchema>={};
 const required:string[]=[];
 for(const tf of model.fields){
  if(tf.kind==='relation'){
   props[tf.name]=tf.list?{type:'array',items:{['x-prisma-model' as any]:tf.type}}:{['x-prisma-model' as any]:tf.type};
  } else {
   props[tf.name]=prismaFieldSchema(tf,schema);
  }
  required.push(tf.name);
 }
 return {type:'object',properties:props,required,['x-prisma-model' as any]:model.name};
}

/** Resolve a nested `{ select: {...} }` / `{ include: {...} }` relation shape. */
function nestedSelection(init:any,field:PrismaField|undefined,schema:PrismaSchema|undefined,ts:any,depth:number):JsonSchema|undefined{
 if(!init||!ts.isObjectLiteralExpression(init))return undefined;
 const get=(name:string)=>init.properties.find((p:any)=>ts.isPropertyAssignment(p)&&(p.name.text??'')===name)?.initializer;
 const subSelect=get('select');
 const subInclude=get('include');
 const props:Record<string,JsonSchema>={};
 const required:string[]=[];
 const targetName=field?.type;
 const target=schema&&targetName?schema.models.get(targetName):undefined;
 const fieldType=(fname:string):JsonSchema=>{
  const tf=target?.fieldByName.get(fname);
  return tf?prismaFieldSchema(tf,schema!):{};
 };
 const readBlock=(block:any)=>{
  if(!block||!ts.isObjectLiteralExpression(block))return;
  for(const f of block.properties){
   if(!ts.isPropertyAssignment(f)||!(ts.isIdentifier(f.name)||ts.isStringLiteralLike(f.name)))continue;
   const fname=f.name.text;
   if(fname==='_count'){const c=buildCount(f.initializer,ts);if(c){props[fname]=c;required.push(fname);}continue;}
   if(f.initializer.kind===ts.SyntaxKind.FalseKeyword)continue;
   if(f.initializer.kind===ts.SyntaxKind.TrueKeyword){
    const tf=target?.fieldByName.get(fname);
    props[fname]=tf?prismaFieldSchema(tf,schema!):{};
    // An explicitly selected key is always present; optionality only nulls it.
    required.push(fname);
    continue;
   }
   const tf=target?.fieldByName.get(fname);
   const nested=schema?nestedSelection(f.initializer,tf,schema,ts,depth+1):nestedSelection(f.initializer,undefined,undefined,ts,depth+1);
   if(nested!==undefined){props[fname]=nested;required.push(fname);}
  }
 };
 if(subSelect){
  readBlock(subSelect);
 } else if(subInclude){
  // include without select: all target scalars plus included relations.
  if(target&&schema)for(const tf of target.fields){
   if(tf.kind==='relation')continue;
   props[tf.name]=prismaFieldSchema(tf,schema);
   required.push(tf.name);
  }
  readBlock(subInclude);
 } else {
  return undefined;
 }
 const obj:JsonSchema={type:'object',properties:props,required};
 if(targetName)obj['x-prisma-model' as any]=targetName;
 // Wrap in an array when the relation is to-many.
 return field?.list?{type:'array',items:obj}:obj;
}

/** `_count: { select: { rel: true } }` -> { rel: number }. */
function buildCount(init:any,ts:any):JsonSchema|undefined{
 if(!init||!ts.isObjectLiteralExpression(init))return undefined;
 const sel=init.properties.find((p:any)=>ts.isPropertyAssignment(p)&&(p.name.text??'')==='select')?.initializer;
 if(!sel||!ts.isObjectLiteralExpression(sel))return undefined;
 const props:Record<string,JsonSchema>={};
 const required:string[]=[];
 for(const f of sel.properties){
  if(ts.isPropertyAssignment(f)&&(ts.isIdentifier(f.name)||ts.isStringLiteralLike(f.name))&&f.initializer?.kind===ts.SyntaxKind.TrueKeyword){
   props[f.name.text]={type:'number'};
   required.push(f.name.text);
  }
 }
 return {type:'object',properties:props,required};
}
