import type {TsAnalysis} from './index.js';

/** Lexical fallback for JS references for which TypeScript supplies no symbol.
 * Search only enclosing scopes; never match a declaration in another function. */
export function localValueDeclaration(analysis:TsAnalysis,node:any):any|undefined {
 const {ts,checker}=analysis;
 if(!node||!ts.isIdentifier(node))return;
 const symbol=ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
 const declaration=symbol?.valueDeclaration??symbol?.declarations?.[0];
 if(declaration)return declaration;
 const binding=(decl:any):any=>{
  if(ts.isIdentifier(decl.name))return decl.name.text===node.text?decl:undefined;
  if(decl.name&&(ts.isObjectBindingPattern(decl.name)||ts.isArrayBindingPattern(decl.name)))for(const el of decl.name.elements){if(ts.isBindingElement(el)){const found=binding(el);if(found)return found}}
 };
 let scope=node.parent;
 while(scope){
  if(ts.isFunctionLike(scope)){for(const param of scope.parameters??[]){const found=binding(param);if(found)return found}}
  if(ts.isBlock(scope)||ts.isSourceFile(scope)){
   const matches:any[]=[];
   for(const stmt of scope.statements){
    if(ts.isVariableStatement(stmt))for(const decl of stmt.declarationList.declarations){const found=binding(decl);if(found)matches.push(found)}
    if(ts.isFunctionDeclaration(stmt)&&stmt.name?.text===node.text)matches.push(stmt);
   }
   if(matches.length)return matches.length===1?matches[0]:undefined;
  }
  scope=scope.parent;
 }
}

/** Resolve lexical/imported constants and object members without running code.
 * Only project-local CommonJS modules are followed. Ambiguous exports stay opaque. */
export function resolveStaticValue(analysis:TsAnalysis,node:any,seen=new Set<any>(),depth=0):any|undefined {
 const {ts,checker}=analysis;
 if(!node||depth>24||seen.has(node))return;
 const next=new Set(seen).add(node);
 const follow=(value:any)=>resolveStaticValue(analysis,value,next,depth+1);
 const moduleSource=(call:any)=>{
  if(!ts.isCallExpression(call)||!ts.isIdentifier(call.expression)||call.expression.text!=='require'||!ts.isStringLiteralLike(call.arguments[0]))return;
  if((checker.getSymbolAtLocation(call.expression)?.declarations??[]).some((d:any)=>analysis.isProjectFile(d.getSourceFile().fileName)))return;
  const path=ts.resolveModuleName(call.arguments[0].text,call.getSourceFile().fileName,analysis.program.getCompilerOptions(),ts.sys).resolvedModule?.resolvedFileName;
  return path&&analysis.isProjectFile(path)?analysis.program.getSourceFile(path):undefined;
 };
 const exported=(source:any,name:string)=>{
  const matches:any[]=[];
  source.forEachChild((child:any)=>{
   if(name==='default'&&ts.isExportAssignment(child))matches.push(child.expression);
   if(!ts.isExpressionStatement(child)||!ts.isBinaryExpression(child.expression)||child.expression.operatorToken.kind!==ts.SyntaxKind.EqualsToken)return;
   const {left,right}=child.expression;
   if(name==='default'&&left.getText()==='module.exports')matches.push(right);
   if(name!=='default'&&['exports.'+name,'module.exports.'+name].includes(left.getText()))matches.push(right);
   if(name!=='default'&&left.getText()==='module.exports'){
    const object=follow(right);
    if(object&&ts.isObjectLiteralExpression(object))for(const prop of object.properties){
     if(prop.name?.text!==name)continue;
     if(ts.isPropertyAssignment(prop))matches.push(prop.initializer);
     else if(ts.isShorthandPropertyAssignment(prop))matches.push(prop.name);
     else if(ts.isMethodDeclaration(prop))matches.push(prop);
    }
   }
  });
  return matches.length===1?follow(matches[0]):undefined;
 };
 if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return follow(node.expression);
 if(ts.isIdentifier(node)){
  let symbol=ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
  const local=(symbol?.declarations??[]).find((d:any)=>ts.isVariableDeclaration(d)&&d.initializer);
  if(local)return follow(local.initializer);
  const localBinding=localValueDeclaration(analysis,node);
  if(localBinding&&ts.isBindingElement(localBinding)){
    const initializer=localBinding.parent?.parent?.initializer;
    const source=initializer&&moduleSource(initializer);
    const name=(localBinding.propertyName??localBinding.name).text;
    if(source&&name)return exported(source,name);
  }
  if(symbol?.flags&ts.SymbolFlags.Alias)symbol=checker.getAliasedSymbol(symbol);
  const declaration=symbol?.valueDeclaration??symbol?.declarations?.[0]??localBinding;
  if(!declaration)return;
  if(ts.isBindingElement(declaration)){
    const initializer=declaration.parent?.parent?.initializer;
    const source=initializer&&moduleSource(initializer);
    const name=(declaration.propertyName??declaration.name).text;
    if(source&&name)return exported(source,name);
  }
  if(ts.isVariableDeclaration(declaration)&&declaration.initializer)return follow(declaration.initializer);
  if(ts.isExportAssignment(declaration))return follow(declaration.expression);
  if(ts.isBinaryExpression(declaration)&&declaration.operatorToken.kind===ts.SyntaxKind.EqualsToken&&declaration.left.getText()==='module.exports')return follow(declaration.right);
  if(ts.isMethodDeclaration(declaration)||ts.isFunctionDeclaration(declaration))return declaration;
  return;
 }
 if(ts.isCallExpression(node)){
  const source=moduleSource(node);if(source)return exported(source,'default');
  return node;
 }
 if(ts.isPropertyAccessExpression(node)||ts.isElementAccessExpression(node)){
  const name=ts.isPropertyAccessExpression(node)?node.name.text:ts.isStringLiteralLike(node.argumentExpression)?node.argumentExpression.text:undefined;
  if(!name)return;
  const receiverDecl=ts.isIdentifier(node.expression)?localValueDeclaration(analysis,node.expression):undefined;
  const source=moduleSource(node.expression)??(receiverDecl&&ts.isVariableDeclaration(receiverDecl)&&receiverDecl.initializer?moduleSource(receiverDecl.initializer):undefined);
  if(source){const member=exported(source,name);if(member)return member;}
  const base=follow(node.expression);
  if(base&&ts.isObjectLiteralExpression(base)){
   const matches=base.properties.filter((prop:any)=>(prop.name?.text??'')===name);
   if(matches.length!==1)return;
   const prop=matches[0];
   if(ts.isMethodDeclaration(prop))return prop;
   if(ts.isPropertyAssignment(prop))return follow(prop.initializer);
   if(ts.isShorthandPropertyAssignment(prop))return follow(prop.name);
  }
  return;
 }
 return node;
}
