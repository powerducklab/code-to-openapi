import {partialSchema} from '../../core/partial-schema.js';
import {dirname, resolve} from 'node:path';
import type {TsAnalysis} from './index.js';
import type {JsonSchema} from '../../core/types.js';

/** Resolve source-declared Sequelize factories without loading/executing them. */
export function sequelizeProjection(analysis: TsAnalysis, query: any): JsonSchema | undefined {
 const {ts,checker}=analysis;
 if(!ts.isCallExpression(query)||!ts.isPropertyAccessExpression(query.expression))return;
 const method=query.expression.name.text;
 if(!['findByPk','findOne','findAll','create'].includes(method))return;
 type Value={kind:string;node?:any;env?:Map<any,Value>;schema?:JsonSchema;options?:any;scope?:any};
 const prop=(object:any,name:string)=>ts.isObjectLiteralExpression(object??{})?object.properties.find((p:any)=>ts.isPropertyAssignment(p)&&p.name?.text===name)?.initializer:undefined;
 const scan=(node:any,predicate:(n:any)=>boolean):any[]=>{const found:any[]=[];const visit=(n:any)=>{if(predicate(n))found.push(n);ts.forEachChild(n,visit);};visit(node);return found;};
 const value=(node:any,env=new Map<any,Value>(),seen=new Set<any>()):Value|undefined=>{
  if(!node||seen.has(node)||seen.size>40)return;
  const next=new Set(seen).add(node),follow=(n:any)=>value(n,env,next);
  if(ts.isParenthesizedExpression(node))return follow(node.expression);
  if(ts.isIdentifier(node)){
   let symbol=checker.getSymbolAtLocation(node);if(env.has(symbol))return env.get(symbol);
   const imported=symbol?.declarations?.find((d:any)=>ts.isImportClause(d)||ts.isImportSpecifier(d)||ts.isNamespaceImport(d));
   if(imported){let statement=imported;while(statement&&!ts.isImportDeclaration(statement))statement=statement.parent;
    if(statement?.moduleSpecifier?.text==='sequelize' && (ts.isImportClause(imported)||ts.isNamespaceImport(imported)||['Sequelize','DataTypes'].includes(imported.propertyName?.text??imported.name.text)))return {kind:'sequelize'};
   }
   if(imported && (symbol?.flags & ts.SymbolFlags.Alias))symbol=checker.getAliasedSymbol(symbol);
   const declarations=(symbol?.declarations??[]).filter((d:any)=>ts.isVariableDeclaration(d));
   if(declarations.length===1&&(declarations[0].parent.flags & ts.NodeFlags.Const))return follow(declarations[0].initializer);
   return;
  }
  if(ts.isArrowFunction(node)||ts.isFunctionExpression(node))return {kind:'factory',node,env};
  if(ts.isObjectLiteralExpression(node))return {kind:'object',node,env};
  if(ts.isNewExpression(node)&&follow(node.expression)?.kind==='sequelize')return {kind:'instance',options:node.arguments?.at(-1)};
  if(ts.isPropertyAccessExpression(node)){
   const base=follow(node.expression);if(base?.kind==='sequelize'&&['DataTypes','Sequelize'].includes(node.name.text))return base;
   if(base?.kind!=='object')return;
   const direct=prop(base.node,node.name.text);if(direct)return value(direct,base.env,next);
   // db.tutorials = require('./tutorial.model')(sequelize, Sequelize)
   const declaration=base.node.parent;
   if(!ts.isVariableDeclaration(declaration))return;
   const symbol=checker.getSymbolAtLocation(declaration.name);
   const assignments=scan(base.node.getSourceFile(),n=>ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(n.left)&&n.left.name.text===node.name.text&&checker.getSymbolAtLocation(n.left.expression)===symbol);
   return assignments.length===1?value(assignments[0].right,base.env,next):undefined;
  }
  if(!ts.isCallExpression(node))return;
  if(ts.isIdentifier(node.expression)&&node.expression.text==='require'&&ts.isStringLiteralLike(node.arguments[0])){
   const spec=node.arguments[0].text;if(spec==='sequelize')return {kind:'sequelize'};
   if(!spec.startsWith('.'))return;
   const target=resolve(dirname(node.getSourceFile().fileName),spec);
   const files=[...analysis.sourceByPath.values()].filter(file=>[target,target+'.js',target+'/index.js',target+'.ts',target+'/index.ts'].includes(resolve(file.fileName)));
   if(files.length!==1)return;
   const exports=scan(files[0],n=>ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&n.left.getText()==='module.exports');
   return exports.length===1?value(exports[0].right,new Map(),next):undefined;
  }
  const callable=follow(node.expression);
  if(callable?.kind==='factory'){
   const bindings=new Map(callable.env);
   callable.node.parameters.forEach((p:any,i:number)=>{const v=follow(node.arguments[i]);if(v)bindings.set(checker.getSymbolAtLocation(p.name),v);});
   const returns=ts.isBlock(callable.node.body)?callable.node.body.statements.filter((n:any)=>ts.isReturnStatement(n)):[];
   const result=ts.isBlock(callable.node.body)?returns.length===1?returns[0].expression:undefined:callable.node.body;
   return value(result,bindings,next);
  }
  if(!ts.isPropertyAccessExpression(node.expression)||node.expression.name.text!=='define')return;
  const instance=follow(node.expression.expression);if(instance?.kind!=='instance')return;
  const attributes=node.arguments[1],options=node.arguments[2];
  if(!attributes||!ts.isObjectLiteralExpression(attributes))return;
  const uncertain:string[]=[];
  if(options&&!ts.isObjectLiteralExpression(options))uncertain.push('Dynamic model configuration');
  const globalOptions=instance.options&&prop(instance.options,'define');
  if(instance.options && (!ts.isObjectLiteralExpression(instance.options)||instance.options.properties.some((p:any)=>!ts.isPropertyAssignment(p))))uncertain.push('Dynamic Sequelize constructor options');
  if(globalOptions&&!ts.isObjectLiteralExpression(globalOptions))uncertain.push('Dynamic global model options');
  if(prop(instance.options,'hooks'))uncertain.push('Constructor hooks may transform the model');
  // Storage-only settings do not change JSON fields. Shape-affecting options
  // are interpreted below; unknown extensions retain evidence with a gap.
  const storageOptions=new Set(['tableName','freezeTableName','underscored','indexes','comment','schema','schemaDelimiter','engine','charset','collate','initialAutoIncrement','validate','version']);
  for(const config of [globalOptions,options]){
   if(!config||!ts.isObjectLiteralExpression(config))continue;
   for(const option of config.properties){
    const key=option.name?.text;
    if(!ts.isPropertyAssignment(option)){uncertain.push('Dynamic model option entry');continue;}
    if(storageOptions.has(key)&&key!=='version')continue;
    if(['timestamps','createdAt','updatedAt','defaultScope','scopes'].includes(key))continue;
    uncertain.push(`Unresolved model option: ${key ?? 'computed key'}`);
   }
  }
  const option=(name:string)=>prop(options,name)??prop(globalOptions,name);
  const timestamps=option('timestamps');
  if(timestamps && ![ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword].includes(timestamps.kind))uncertain.push('Dynamic timestamps configuration');
  const properties:Record<string,JsonSchema>={};let primary=false;
  for(const field of attributes.properties){
   if(!ts.isPropertyAssignment(field)||!field.name?.text)return;
   const definition=field.initializer;
   const type=prop(definition,'type')??definition;
   const typeNode=ts.isCallExpression(type)?type.expression:type;
   const name=ts.isPropertyAccessExpression(typeNode)&&follow(typeNode.expression)?.kind==='sequelize'?typeNode.name.text:undefined;
   const primitive:Record<string,string>={STRING:'string',TEXT:'string',BOOLEAN:'boolean',INTEGER:'integer',SMALLINT:'integer',FLOAT:'number',DOUBLE:'number',DATE:'string',UUID:'string'};
   const primaryKey=prop(definition,'primaryKey')?.kind===ts.SyntaxKind.TrueKeyword;
   const primaryOption=prop(definition,'primaryKey');
   if(primaryOption && ![ts.SyntaxKind.TrueKeyword,ts.SyntaxKind.FalseKeyword].includes(primaryOption.kind))return;
   primary ||= primaryKey;
   const nullable=!primaryKey&&prop(definition,'allowNull')?.kind!==ts.SyntaxKind.FalseKeyword;
   properties[field.name.text]=name&&primitive[name]?{type:nullable?[primitive[name]!,'null']:primitive[name]!,...(name==='DATE'?{format:'date-time'}:name==='UUID'?{format:'uuid'}:{})}:{};
   if(prop(definition,'get'))properties[field.name.text]={};
  }
  if(!primary&&!('id'in properties))properties.id={type:'integer'};
  if(!timestamps || timestamps.kind===ts.SyntaxKind.TrueKeyword){
   for(const key of ['createdAt','updatedAt']){
    const rename=option(key);if(rename?.kind===ts.SyntaxKind.FalseKeyword)continue;
    if(rename&&!ts.isStringLiteralLike(rename)){uncertain.push(`Dynamic timestamp name: ${key}`);continue;}
    properties[rename?.text??key]={type:'string',format:'date-time'};
   }
  }
  let schema:JsonSchema={type:'object',properties,required:Object.keys(properties)};
  for(const reason of uncertain)schema=partialSchema(schema,reason,true);
  return {kind:'model',schema,scope:option('defaultScope')};
 };
 const model=value(query.expression.expression);if(model?.kind!=='model'||!model.schema)return;
 const project=(schema:JsonSchema,attributes:any):JsonSchema=>{
  if(!attributes)return schema;
  if(!schema.properties)return partialSchema(schema,'Projection on an unresolved model',true);
  let properties={...schema.properties} as Record<string,JsonSchema>;
  if(ts.isArrayLiteralExpression(attributes)){
   const selected:Record<string,JsonSchema>={};
   for(const item of attributes.elements){
    if(ts.isStringLiteralLike(item))selected[item.text]=properties[item.text]??{};
    else if(ts.isArrayLiteralExpression(item)&&item.elements.length===2&&ts.isStringLiteralLike(item.elements[1])){
     const [source,alias]=item.elements;selected[alias.text]=ts.isStringLiteralLike(source)?properties[source.text]??{}:{};
    }else return partialSchema(schema,'Dynamic attribute projection',true);
   }
   properties=selected;
  }else if(ts.isObjectLiteralExpression(attributes)){
   const exclude=prop(attributes,'exclude');
   if(attributes.properties.some((p:any)=>!ts.isPropertyAssignment(p)||p.name.text!=='exclude')||!exclude||!ts.isArrayLiteralExpression(exclude)||exclude.elements.some((n:any)=>!ts.isStringLiteralLike(n)))return partialSchema(schema,'Unresolved attribute inclusion/exclusion',true);
   for(const key of exclude.elements)delete properties[key.text];
  }else return partialSchema(schema,'Dynamic attribute projection',true);
  return {...schema,properties,required:Object.keys(properties)};
 };
 let shape=model.schema;
 const options=query.arguments[method==='findAll'||method==='findOne'?0:1];
 const scope=method==='create'?undefined:model.scope;
 // Explicit attributes replace scoped attributes. Other unresolved scope
 // transforms stay visible rather than silently publishing a full model.
 const explicitAttributes=prop(options,'attributes');
 for(const config of [scope,options]){
  if(!config)continue;
  if(!ts.isObjectLiteralExpression(config)){shape=partialSchema(shape,'Dynamic query/scope configuration',true);continue;}
  for(const entry of config.properties){
   if(!ts.isPropertyAssignment(entry)){shape=partialSchema(shape,'Dynamic query/scope entry',true);continue;}
   if(['attributes','where','limit','offset','order','transaction','logging','raw','rejectOnEmpty'].includes(entry.name.text))continue;
   shape=partialSchema(shape,`Unresolved query/scope option: ${entry.name.text}`,true);
  }
 }
 shape=project(shape,explicitAttributes??prop(scope,'attributes'));
 return method==='findAll'?{type:'array',items:shape}:method==='create'?shape:{anyOf:[shape,{type:'null'}]};
}
