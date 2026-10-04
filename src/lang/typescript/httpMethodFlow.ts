/** Narrow explicit HTTP-method branches without cloning or mutating TS nodes. */
import type {TsAnalysis} from './index.js';

export function httpMethodReachability(analysis:TsAnalysis, handler:any, method:string):Set<any> & {uncertain:boolean} {
 const {ts,checker}=analysis;
 const request=handler.parameters?.[0]?.name;
 const requestSymbol=request&&ts.isIdentifier(request)?checker.getSymbolAtLocation(request):undefined;
 const reachable=Object.assign(new Set<any>(), {uncertain:false});
 const isRequest=(node:any)=>!!requestSymbol&&ts.isIdentifier(node)&&checker.getSymbolAtLocation(node)===requestSymbol;
 function methodAccess(node:any):boolean {
  return (ts.isPropertyAccessExpression(node)&&node.name.text==='method'&&isRequest(node.expression))||
   (ts.isElementAccessExpression(node)&&isRequest(node.expression)&&ts.isStringLiteralLike(node.argumentExpression)&&node.argumentExpression.text==='method');
 }
 let stableRequest=true;
 function inspect(node:any):void {
  if(!node)return;
  if(isRequest(node)){
   const parent=node.parent;
   // Aliasing or passing the whole request to user code can mutate its method.
   if(!parent||!((ts.isPropertyAccessExpression(parent)||ts.isElementAccessExpression(parent))&&parent.expression===node))stableRequest=false;
  }
  if(ts.isBinaryExpression(node)&&node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&node.operatorToken.kind<=ts.SyntaxKind.LastAssignment){
   if(methodAccess(node.left)||(ts.isElementAccessExpression(node.left)&&isRequest(node.left.expression)))stableRequest=false;
  }
  if((ts.isDeleteExpression(node)||((ts.isPrefixUnaryExpression(node)||ts.isPostfixUnaryExpression(node))&&
    [ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator)))&&methodAccess(node.expression??node.operand))stableRequest=false;
  ts.forEachChild(node,inspect);
 }
 if(handler.body)inspect(handler.body);
 reachable.uncertain=!stableRequest;
 function value(node:any,seen=new Set<any>()):unknown {
  if(!node||seen.has(node))return undefined;
  const next=new Set(seen).add(node);
  if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return value(node.expression,next);
  if(ts.isStringLiteralLike(node))return node.text;
  if(node.kind===ts.SyntaxKind.TrueKeyword)return true;
  if(node.kind===ts.SyntaxKind.FalseKeyword)return false;
  if(methodAccess(node))return stableRequest?method.toUpperCase():undefined;
  if(ts.isIdentifier(node)){
   const declaration=checker.getSymbolAtLocation(node)?.valueDeclaration;
   if(declaration&&ts.isVariableDeclaration(declaration)&&declaration.parent.flags&ts.NodeFlags.Const)return value(declaration.initializer,next);
  }
  if(ts.isPrefixUnaryExpression(node)&&node.operator===ts.SyntaxKind.ExclamationToken){const v=value(node.operand,next);return typeof v==='boolean'?!v:undefined;}
  if(ts.isBinaryExpression(node)){
   const left=value(node.left,next),right=value(node.right,next),operator=node.operatorToken.kind;
   if(operator===ts.SyntaxKind.AmpersandAmpersandToken)return left===false||right===false?false:left===true&&right===true?true:undefined;
   if(operator===ts.SyntaxKind.BarBarToken)return left===true||right===true?true:left===false&&right===false?false:undefined;
   if(left===undefined||right===undefined)return undefined;
   if([ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.EqualsEqualsEqualsToken].includes(operator))return left===right;
   if([ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator))return left!==right;
  }
  return undefined;
 }
 type Exit='continue'|'return'|'break';
 function visit(node:any):Exit {
  if(!node)return 'continue';reachable.add(node);
  if(ts.isFunctionLike(node))return 'continue';
  if(ts.isBlock(node)){
   for(const statement of node.statements){const exit=visit(statement);if(exit!=='continue')return exit;}
   return 'continue';
  }
  if(ts.isIfStatement(node)){
   visit(node.expression);const condition=value(node.expression);
   if(condition===true)return visit(node.thenStatement);
   if(condition===false)return visit(node.elseStatement);
   const a=visit(node.thenStatement),b=visit(node.elseStatement);return a===b?a:'continue';
  }
  if(ts.isSwitchStatement(node)){
   visit(node.expression);const target=value(node.expression);
   // An unresolved case may match before a known case (or the default).
   // Pruning it would silently discard a handler response.
   const casesKnown=node.caseBlock.clauses.every((clause:any)=>
    ts.isDefaultClause(clause)||value(clause.expression)!==undefined);
   if(!casesKnown)reachable.uncertain=true;
   if(typeof target==='string'&&casesKnown){
    reachable.add(node.caseBlock);const clauses=node.caseBlock.clauses;
    let start=clauses.findIndex((clause:any)=>ts.isCaseClause(clause)&&value(clause.expression)===target);
    if(start<0)start=clauses.findIndex((clause:any)=>ts.isDefaultClause(clause));
    if(start<0)return 'continue';
    for(let i=start;i<clauses.length;i++){
     const clause=clauses[i];reachable.add(clause);if(clause.expression)visit(clause.expression);
     for(const statement of clause.statements){const exit=visit(statement);if(exit==='break')return 'continue';if(exit==='return')return exit;}
    }
    return 'continue';
   }
  }
  ts.forEachChild(node,(child:any)=>{visit(child);});
  if(ts.isReturnStatement(node)||ts.isThrowStatement(node))return 'return';
  if(ts.isBreakStatement(node)&&!node.label)return 'break';
  return 'continue';
 }
 if(handler.body)visit(handler.body);
 return reachable;
}
