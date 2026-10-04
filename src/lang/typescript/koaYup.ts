import type {TsAnalysis} from './index.js';
import type {JsonSchema} from '../../core/types.js';
import {resolveStaticValue} from './staticValue.js';
import {yupSchema} from './yup.js';

/** Registries must be installed by a real initializer call on a proven Koa app. */
export function koaSchemaRegistry(analysis:TsAnalysis):Map<string,any>{
 const {ts,checker}=analysis;const registry=new Map<string,any>();const conflicts=new Set<string>();
 for(const source of analysis.sourceByPath.values()){
  const visit=(node:any)=>{
   if(ts.isCallExpression(node)&&node.arguments[0]){
    const app=resolveStaticValue(analysis,node.arguments[0]);
    const ctor=app&&ts.isNewExpression(app)?resolveStaticValue(analysis,app.expression):undefined;
    if(ctor&&ts.isCallExpression(ctor)&&ctor.expression.getText()==='require'&&ctor.arguments[0]?.text==='koa'){
     const init=resolveStaticValue(analysis,node.expression);
     if(init?.body&&init.parameters?.[0]){
      const parameter=checker.getSymbolAtLocation(init.parameters[0].name);
      const collect=(n:any)=>{
       if(n!==init.body&&ts.isFunctionLike(n))return;
       if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(n.left)&&n.left.name.text==='schemas'&&checker.getSymbolAtLocation(n.left.expression)===parameter&&ts.isObjectLiteralExpression(n.right)){
        for(const prop of n.right.properties){
         if(!(ts.isShorthandPropertyAssignment(prop)||ts.isPropertyAssignment(prop)))continue;
         const name=prop.name.text,value=resolveStaticValue(analysis,ts.isShorthandPropertyAssignment(prop)?prop.name:prop.initializer);
         if(!value||!name)continue;
         if(registry.has(name)&&registry.get(name)!==value)conflicts.add(name);else registry.set(name,value);
        }
       }ts.forEachChild(n,collect);
      };collect(init.body);
     }
    }
   }ts.forEachChild(node,visit);
  };source.forEachChild(visit);
 }
 for(const name of conflicts)registry.delete(name);
 return registry;
}

export function koaYupBody(analysis:TsAnalysis,handler:any,registry:Map<string,any>):{schema?:JsonSchema;warnings:Set<string>;bodyReferenced:boolean;validatedValues:Map<any,JsonSchema>}{
 const {ts,checker}=analysis;const warnings=new Set<string>();const validatedValues=new Map<any,JsonSchema>();const written=new Map<any,Set<string>>();const aliases=new Map<any,string[]>();
 const ctxName=handler.parameters?.[0]?.name;const ctx=ctxName?checker.getSymbolAtLocation(ctxName):undefined;let bodyReferenced=false;let schema:JsonSchema|undefined;
 if(!ctx)return {warnings,bodyReferenced,validatedValues};
 const path=(node:any):string[]|undefined=>{
  if(!node)return;
  if(ts.isIdentifier(node))return aliases.get(checker.getSymbolAtLocation(node));
  if(ts.isPropertyAccessExpression(node)){
   if(node.name.text==='request'&&checker.getSymbolAtLocation(node.expression)===ctx)return ['@request'];
   const base=path(node.expression);if(base)return base[0]==='@request'?node.name.text==='body'?[]:undefined:[...base,node.name.text];
  }
 };
 const bind=(name:any,base:string[]|undefined)=>{
  if(!base)return;
  if(ts.isIdentifier(name)){aliases.set(checker.getSymbolAtLocation(name),base);return;}
  if(ts.isObjectBindingPattern(name))for(const item of name.elements){
   if(item.dotDotDotToken)continue;
   const key=(item.propertyName??item.name).text;if(!key)continue;
   const next=base[0]==='@request'?key==='body'?[]:undefined:[...base,key];
   if(next){bodyReferenced=true;bind(item.name,next);}
  }
 };
 const literalObject=(node:any):Record<string,unknown>|undefined=>{
  const value=resolveStaticValue(analysis,node);if(!value||!ts.isObjectLiteralExpression(value))return;
  const result:Record<string,unknown>={};
  for(const p of value.properties){if(!ts.isPropertyAssignment(p))return;const v=p.initializer;
   if(ts.isStringLiteralLike(v))result[p.name.text]=v.text;
   else if(ts.isNumericLiteral(v))result[p.name.text]=Number(v.text);
   else if(v.kind===ts.SyntaxKind.TrueKeyword||v.kind===ts.SyntaxKind.FalseKeyword)result[p.name.text]=v.kind===ts.SyntaxKind.TrueKeyword;
   else return;
  }return result;
 };
 const visit=(node:any)=>{
  if(node!==handler.body&&ts.isFunctionLike(node))return;
  if(ts.isVariableDeclaration(node))bind(node.name,path(node.initializer));
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left)&&ts.isIdentifier(node.left.expression)&&node.parent?.parent===handler.body){
   const symbol=checker.getSymbolAtLocation(node.left.expression);const keys=written.get(symbol)??new Set<string>();keys.add(node.left.name.text);written.set(symbol,keys);
  }
  const inputPath=path(node);if(inputPath&&inputPath[0]!=='@request')bodyReferenced=true;
  if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['validate','validateSync'].includes(node.expression.name.text)){
   const parts:string[]=[];let root=node.expression.expression;
   while(ts.isPropertyAccessExpression(root)){parts.unshift(root.name.text);root=root.expression;}
   const input=path(node.arguments[0]);
   if(checker.getSymbolAtLocation(root)===ctx&&parts.length===3&&parts[0]==='app'&&parts[1]==='schemas'&&input){
    const definition=registry.get(parts[2]!);if(!definition){warnings.add('Unresolved Koa schema registry');return;}
    const options=resolveStaticValue(analysis,node.arguments[1]);
    const contextNode=options&&ts.isObjectLiteralExpression(options)?options.properties.find((p:any)=>ts.isPropertyAssignment(p)&&p.name.text==='context')?.initializer:undefined;
    let context=literalObject(contextNode);
    // A mutable options context cannot be frozen at its initial value.
    const optsSymbol=node.arguments[1]&&ts.isIdentifier(node.arguments[1])?checker.getSymbolAtLocation(node.arguments[1]):undefined;
    if(optsSymbol){const check=(n:any)=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken){let r=n.left;while(ts.isPropertyAccessExpression(r))r=r.expression;if(checker.getSymbolAtLocation(r)===optsSymbol)context=undefined;}ts.forEachChild(n,check);};check(handler.body);}
    const output=yupSchema(analysis,definition,{mode:'output',context,warnings});
    const supplied=node.arguments[0]&&ts.isIdentifier(node.arguments[0])?written.get(checker.getSymbolAtLocation(node.arguments[0])):undefined;
    if(output){output.required=[...new Set([...(output.required as string[]??[]),...[...(supplied??[])].filter(key=>key in ((output.properties as Record<string,JsonSchema>)??{}))])];validatedValues.set(node,output);}
    let body=yupSchema(analysis,definition,{mode:'input',context,warnings});
    if(body&&supplied){for(const key of supplied){delete (body.properties as Record<string,JsonSchema>|undefined)?.[key];if(Array.isArray(body.required))body.required=body.required.filter(k=>k!==key);}}
    if(body){for(const key of [...input].reverse())body={type:'object',properties:{[key]:body},...(Array.isArray(body.required)&&body.required.length?{required:[key]}:{})};schema=body;}
   }
  }
  ts.forEachChild(node,visit);
 };
 if(handler.body)visit(handler.body);
 return {schema,warnings,bodyReferenced,validatedValues};
}
