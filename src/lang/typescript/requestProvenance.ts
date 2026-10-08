import type {TsAnalysis} from './index.js';
import {resolveStaticValue, localValueDeclaration} from './staticValue.js';

/** Project-local request dataflow. Framework adapters add edges for documented
 * callback contracts; model inference consumes the same edges as local code. */
const passportRegistrations = new WeakMap<TsAnalysis, Map<string, any[]>>();

export interface RequestProvenance {
  values: Map<any, any[]>;
  writes: Map<string, any[]>;
  requestRoots: Set<any>;
  unresolvedFailures: boolean;
}
export function symbolDeclaration(analysis: TsAnalysis, node: any): any {
  return localValueDeclaration(analysis,node);
}
/** External identity, never a bare method/variable name heuristic. */
export function externalReference(analysis:TsAnalysis,node:any,seen=new Set<any>()):{module:string;members:string[]}|undefined {
  const {ts,checker}=analysis;
  if(!node||seen.has(node)||seen.size>24)return;
  const next=new Set([...seen,node]);
  if(ts.isPropertyAccessExpression(node)){
    const base=externalReference(analysis,node.expression,next);
    return base?{module:base.module,members:[...base.members,node.name.text]}:undefined;
  }
  if(ts.isIdentifier(node)){
    const decl=symbolDeclaration(analysis,node);
    if(decl&&ts.isVariableDeclaration(decl))return externalReference(analysis,decl.initializer,next);
    if(decl&&ts.isBindingElement(decl)){
      const base=externalReference(analysis,decl.parent?.parent?.initializer,next);
      return base?{module:base.module,members:[...base.members,(decl.propertyName??decl.name).text]}:undefined;
    }
    if(decl&&(ts.isImportClause(decl)||ts.isImportSpecifier(decl)||ts.isNamespaceImport(decl))){
      let statement=decl;while(statement&&!ts.isImportDeclaration(statement))statement=statement.parent;
      if(statement&&ts.isStringLiteralLike(statement.moduleSpecifier))return{module:statement.moduleSpecifier.text,members:ts.isImportSpecifier(decl)?[(decl.propertyName??decl.name).text]:[]};
    }
  }
  if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0])){
    if((checker.getSymbolAtLocation(node.expression)?.declarations??[]).some((d:any)=>analysis.isProjectFile(d.getSourceFile().fileName)))return;
    return {module:node.arguments[0].text,members:[]};
  }
}
export function requestPath(analysis:TsAnalysis,flow:RequestProvenance,node:any,seen=new Set<any>()):string|undefined {
  const {ts}=analysis;
  if(!node||seen.has(node)||seen.size>32)return;
  const next=new Set([...seen,node]);
  if(ts.isPropertyAccessExpression(node)){
    const base=requestPath(analysis,flow,node.expression,next);
    return base===undefined?undefined:`${base}.${node.name.text}`;
  }
  if(ts.isIdentifier(node)){
    const decl=symbolDeclaration(analysis,node);
    if(flow.requestRoots.has(decl))return '';
    const values=flow.values.get(decl)??(decl?.initializer?[decl.initializer]:[]);
    const paths=values.map(value=>requestPath(analysis,flow,value,next));
    if(paths.length&&paths[0]!==undefined&&paths.every(p=>p===paths[0]))return paths[0];
  }
}

export function collectRequestProvenance(analysis:TsAnalysis,handler:any,loaders:any[],middleware:any[]):RequestProvenance {
  const {ts}=analysis;
  const flow:RequestProvenance={values:new Map(),writes:new Map(),requestRoots:new Set(),unresolvedFailures:false};
  const add=(map:Map<any,any[]>,key:any,value:any):void=>{if(!key||!value)return;const entries=map.get(key)??[];if(!entries.includes(value))entries.push(value);map.set(key,entries)};
  const own=(fn:any,predicate:(node:any)=>boolean):any[]=>{
    const nodes:any[]=[];
    const walk=(node:any):void=>{if(node!==fn&&ts.isFunctionLike(node))return;if(predicate(node))nodes.push(node);ts.forEachChild(node,walk)};
    walk(fn);return nodes;
  };
  const bindArguments=(fn:any,args:any[]):void=>fn.parameters?.forEach((param:any,i:number)=>{if(args[i])add(flow.values,param,args[i])});
  const callable=(expr:any,seen=new Set<any>()):any=>{
    if(!expr||seen.has(expr)||seen.size>24)return;
    const next=new Set([...seen,expr]);
    const resolved=resolveStaticValue(analysis,expr);
    if(resolved&&ts.isFunctionLike(resolved)&&resolved.body)return resolved;
    if(ts.isCallExpression(expr)){
      const factory=callable(expr.expression,next);if(!factory)return;
      bindArguments(factory,expr.arguments);
      const returns=ts.isBlock(factory.body)?own(factory,n=>ts.isReturnStatement(n)).map(n=>n.expression):[factory.body];
      if(returns.length===1&&returns[0]&&ts.isFunctionLike(returns[0]))return returns[0];
    }
  };
  const passport=(node:any):boolean=>{
    const ref=externalReference(analysis,node);return ref?.module==='passport'&&!ref.members.length;
  };
  const strategyValues=(name:string):any[]=>{
    let registry=passportRegistrations.get(analysis);
    if(!registry){
      registry=new Map();
      for(const source of analysis.sourceByPath.values()){
        const walk=(node:any):void=>{
          if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='use'&&passport(node.expression.expression)&&node.arguments.length===2&&ts.isStringLiteralLike(node.arguments[0])){
            const key=node.arguments[0].text;
            const entries=registry!.get(key)??[];entries.push(node.arguments[1]);registry!.set(key,entries);
          }
          ts.forEachChild(node,walk);
        };walk(source);
      }
      passportRegistrations.set(analysis,registry);
    }
    const registrations=registry.get(name)??[];
    // Duplicate registrations are order-dependent; do not pick a convenient one.
    if(registrations.length!==1)return [];
    const instance=resolveStaticValue(analysis,registrations[0]);
    if(!instance||!ts.isNewExpression(instance))return [];
    const ref=externalReference(analysis,instance.expression);
    const supported=ref&&((ref.module==='passport-jwt'&&ref.members.join('.')==='Strategy')||((ref.module==='passport-local'||ref.module==='passport-http-bearer')&&(!ref.members.length||ref.members.join('.')==='Strategy')));
    if(!supported)return [];
    const verify=callable(instance.arguments?.at(-1));if(!verify)return [];
    const done=verify.parameters.at(-1);
    const calls=own(verify,n=>ts.isCallExpression(n)&&symbolDeclaration(analysis,n.expression)===done);
    const successes:any[]=[];
    for(const call of calls){
      if(call.arguments[0]?.kind===ts.SyntaxKind.NullKeyword&&call.arguments[1]&&call.arguments[1].kind!==ts.SyntaxKind.FalseKeyword&&call.arguments[1].kind!==ts.SyntaxKind.NullKeyword)successes.push(call.arguments[1]);
    }
    return successes;
  };
  const write=(key:string,value:any):void=>{
    add(flow.writes,key,value);
    if(ts.isObjectLiteralExpression(value)&&!value.properties.some((p:any)=>ts.isSpreadAssignment(p)||(p.name&&ts.isComputedPropertyName(p.name)))){
      for(const prop of value.properties){
        if(ts.isShorthandPropertyAssignment(prop))write(`${key}.${prop.name.text}`,prop.name);
        else if(ts.isPropertyAssignment(prop))write(`${key}.${prop.name.text}`,prop.initializer);
      }
    }
  };
  const visit=(fn:any,stack=new Set<any>()):void=>{
    if(!fn||stack.has(fn)||stack.size>24)return;
    const next=new Set([...stack,fn]);
    for(const node of own(fn,n=>ts.isBinaryExpression(n)||ts.isCallExpression(n))){
      if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken){
        const path=requestPath(analysis,flow,node.left);if(path)write(path,node.right);
      }
      if(!ts.isCallExpression(node))continue;
      if(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='authenticate'&&passport(node.expression.expression)){
        flow.unresolvedFailures=true;
        const name=node.arguments[0];if(!name||!ts.isStringLiteralLike(name))continue;
        const sources=strategyValues(name.text);if(!sources.length)continue;
        const callbackExpr=node.arguments.length===3?node.arguments[2]:node.arguments.length===2?node.arguments[1]:undefined;
        const callback=callable(callbackExpr);
        if(callback?.parameters?.[1]){
          for(const source of sources)add(flow.values,callback.parameters[1],source);
          visit(callback,next);
        }else if(node.arguments.length===1||(node.arguments.length===2&&ts.isObjectLiteralExpression(node.arguments[1]))){
          // Default Passport request field. Custom property options stay opaque.
          const options=node.arguments[1];
          if(options?.properties.some((p:any)=>!ts.isPropertyAssignment(p)||!['session','failureRedirect','successRedirect','failWithError'].includes(p.name.text)))continue;
          for(const source of sources)write('.user',source);
        }
      }else{
        const target=callable(node.expression);
        if(target){bindArguments(target,node.arguments);visit(target,next)}
      }
    }
  };
  const root=(fn:any):void=>{if(fn?.parameters?.[0])flow.requestRoots.add(fn.parameters[0]);visit(fn)};
  if(handler.parameters?.[0])flow.requestRoots.add(handler.parameters[0]);
  for(const loader of loaders)root(loader);
  for(const reference of middleware)root(callable(reference) ?? reference);
  return flow;
}
