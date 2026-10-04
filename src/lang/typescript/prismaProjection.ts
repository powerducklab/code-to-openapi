import type {TsAnalysis} from './index.js';
import type {JsonSchema} from '../../core/types.js';

/** A selected payload is narrower than its declared full entity type. This
 * helper only proves selected keys; generated/client field types remain separate. */
export function prismaProjection(analysis:TsAnalysis,node:any):JsonSchema|undefined {
 const {ts,checker}=analysis;
 if(!ts.isCallExpression(node)||!ts.isPropertyAccessExpression(node.expression))return;
 const method=node.expression.name.text;
 if(!['findUnique','findFirst','findUniqueOrThrow','findFirstOrThrow','create','update','upsert','findMany'].includes(method))return;
 const delegate=node.expression.expression;
 if(!ts.isPropertyAccessExpression(delegate))return;
 const importedClient=(name:any)=>{
  const symbol=checker.getSymbolAtLocation(name);
  return (symbol?.declarations??[]).some((d:any)=>ts.isImportSpecifier(d)&&(d.propertyName?.text??d.name.text)==='PrismaClient'&&d.parent?.parent?.parent?.moduleSpecifier?.text==='@prisma/client');
 };
 const isClient=(value:any,seen=new Set<any>(),depth=0):boolean=>{
  if(!value||depth>12||seen.has(value))return false;
  const next=new Set(seen).add(value);
  if(ts.isNewExpression(value))return importedClient(value.expression);
  if(ts.isBinaryExpression(value)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(value.operatorToken.kind))return isClient(value.left,next,depth+1)&&isClient(value.right,next,depth+1);
  let symbol=checker.getSymbolAtLocation(ts.isPropertyAccessExpression(value)?value.name:value);
  if(symbol?.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
  return (symbol?.declarations??[]).some((d:any)=>{
   if(d.type&&ts.isTypeReferenceNode(d.type)&&importedClient(d.type.typeName))return true;
   if(ts.isVariableDeclaration(d)&&d.initializer)return isClient(d.initializer,next,depth+1);
   if(ts.isExportAssignment(d))return isClient(d.expression,next,depth+1);
   return false;
  });
 };
 if(!isClient(delegate.expression))return;
 const options=node.arguments[0];if(!options||!ts.isObjectLiteralExpression(options))return;
 const selection=options.properties.find((p:any)=>ts.isPropertyAssignment(p)&&(p.name.text??'')==='select')?.initializer;
 if(!selection||!ts.isObjectLiteralExpression(selection))return;
 const properties:Record<string,JsonSchema>={};
 for(const field of selection.properties){
  if(!ts.isPropertyAssignment(field)||!(ts.isIdentifier(field.name)||ts.isStringLiteralLike(field.name)))return;
  if(field.initializer.kind===ts.SyntaxKind.FalseKeyword)continue;
  if(field.initializer.kind!==ts.SyntaxKind.TrueKeyword)return;
  properties[field.name.text]={};
 }
 const object:JsonSchema={type:'object',properties,required:Object.keys(properties)};
 if(method==='findMany')return {type:'array',items:object};
 if(method==='findUnique'||method==='findFirst')return {anyOf:[object,{type:'null'}]};
 return object;
}
