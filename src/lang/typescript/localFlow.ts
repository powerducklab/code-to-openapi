import type {JsonSchema} from '../../core/types.js';
import type {TsAnalysis} from './index.js';
import {typeToSchema} from './typeSchema.js';
import {resolveStaticValue} from './staticValue.js';
import {prismaProjection} from './prismaProjection.js';
import {mongooseProjection} from './mongoose.js';

/** Method names that never mutate their receiver; a call like `arr.map(fn)`
 * returns a fresh value, so the receiver is not escaping/mutated by the call. */
const PURE_READONLY_CALLS = new Set([
  "map", "filter", "flatMap", "flat", "slice", "concat", "join", "indexOf",
  "lastIndexOf", "find", "findIndex", "some", "every", "reduce", "reduceRight",
  "includes", "keys", "values", "entries", "at", "findLast", "findLastIndex",
  "toSorted", "toReversed", "toSpliced", "with",
]);

/** Return the type-annotation text of an Error-like handler parameter. */
function errorParameterTypeText(ts: any, checker: any, node: any): string | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
  if (declaration && ts.isParameter(declaration)) {
    if (declaration.type) return declaration.type.getText();
    // Unannotated first parameter of a four-argument handler follows the
    // Express error-middleware / Node error-callback convention (err, req,
    // res, next), so it is treated as an Error even when contextual typing
    // leaves it implicitly any.
    const owner = declaration.parent;
    if (
      ts.isFunctionLike(owner) &&
      owner.parameters.length === 4 &&
      owner.parameters[0] === declaration
    ) {
      return "Error";
    }
  }
  return undefined;
}

/** Follow only resolved local implementations. External libraries remain opaque. */
export function localImplementation(analysis: TsAnalysis, call: any): any | undefined {
 const {ts,checker}=analysis;
 const signature=checker.getResolvedSignature(call)?.declaration;
 const declarations=checker.getSymbolAtLocation(call.expression)?.declarations??[];
 const candidate=[signature,...declarations].find(d=>d?.body&&analysis.isProjectFile(d.getSourceFile().fileName));
 if(candidate)return candidate;
 const staticFn=resolveStaticValue(analysis,call.expression);
 if(staticFn?.body&&analysis.isProjectFile(staticFn.getSourceFile().fileName)&&(ts.isFunctionLike(staticFn)))return staticFn;
 const variable=declarations.find((d:any)=>ts.isVariableDeclaration(d)&&d.initializer&&(ts.isArrowFunction(d.initializer)||ts.isFunctionExpression(d.initializer)));
 return variable&&analysis.isProjectFile(variable.getSourceFile().fileName)?variable.initializer:undefined;
}

export function localReturnSchema(analysis: TsAnalysis, method: any, fallback: (node:any)=>JsonSchema|undefined, expressionMode = false, onEvidence?: () => void, initialBindings?: ReadonlyMap<any,JsonSchema>): JsonSchema|undefined {
 const {ts,checker}=analysis;
 const bindings=new Map(initialBindings);
 const mutations=new Map<any,boolean>();
 const isMutable=(decl:any)=>{
  if(mutations.has(decl))return mutations.get(decl)!;
  const symbol=checker.getSymbolAtLocation(decl.name);
  const valueType=checker.getTypeAtLocation(decl.name);
  if(valueType.flags & (ts.TypeFlags.StringLike|ts.TypeFlags.NumberLike|ts.TypeFlags.BooleanLike|ts.TypeFlags.Null|ts.TypeFlags.Undefined))return false;
  let scope=decl.parent;
  while(scope.parent&&!ts.isFunctionLike(scope)&&!ts.isSourceFile(scope))scope=scope.parent;
  let unsafe=false;
  const rooted=(n:any):boolean=>{
   while(n&&(ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n)||ts.isAsExpression(n)||ts.isParenthesizedExpression(n)||ts.isNonNullExpression(n)))n=n.expression;
   return !!n&&ts.isIdentifier(n)&&checker.getSymbolAtLocation(n)===symbol;
  };
  const visit=(n:any)=>{
   if(unsafe)return;
   if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment&&rooted(n.left))unsafe=true;
   if(ts.isDeleteExpression(n)&&rooted(n.expression))unsafe=true;
   if((ts.isPostfixUnaryExpression(n)||ts.isPrefixUnaryExpression(n))&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(n.operator)&&rooted(n.operand))unsafe=true;
   // Passing the value as an argument to a call is not itself a mutation:
   // mappers and helpers read their inputs. Only a call that mutates the
   // receiver (non-readonly method call) or an explicit write marks it unsafe.
   if(ts.isCallExpression(n)&&(!ts.isPropertyAccessExpression(n.expression)||!PURE_READONLY_CALLS.has(n.expression.name.text))&&rooted(n.expression))unsafe=true;
   if(ts.isVariableDeclaration(n)&&n!==decl&&n.initializer&&ts.isIdentifier(n.initializer)&&rooted(n.initializer))unsafe=true;
   ts.forEachChild(n,visit);
  };visit(scope);mutations.set(decl,unsafe);return unsafe;
 };
 const infer=(node:any,seen:Set<any>,depth:number):JsonSchema|undefined=>{
  if(!node||depth>16||seen.has(node))return undefined;
  const next=new Set(seen).add(node);
  if(ts.isIdentifier(node)){
   const symbol=ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
   if(bindings.has(symbol))return bindings.get(symbol);
  }
  if(ts.isAwaitExpression(node)||ts.isParenthesizedExpression(node)||ts.isNonNullExpression(node))return infer(node.expression,next,depth+1);
  if(ts.isAsExpression(node))return fill(infer(node.expression,next,depth+1),fallback(node),0);
 // Ternary `cond ? a : b`: union the proven branches. When both branches prove
 // the same primitive (e.g. boolean), collapse to that primitive.
 if(ts.isConditionalExpression(node)){
  const a=infer(node.whenTrue,next,depth+1);
  const b=infer(node.whenFalse,next,depth+1);
  if(a||b){
   onEvidence?.();
   if(a&&b&&a.type===b.type&&!Array.isArray(a.type))return a;
   const branches=[a,b].filter(Boolean) as JsonSchema[];
   return branches.length===1?branches[0]:{anyOf:branches};
  }
 }
 // Null coalescing / logical fallback `a ?? b`, `a || b`: union both sides.
 if(ts.isBinaryExpression(node)&&(node.operatorToken.kind===ts.SyntaxKind.QuestionQuestionToken||node.operatorToken.kind===ts.SyntaxKind.BarBarToken)){
  const a=infer(node.left,next,depth+1);
  const b=infer(node.right,next,depth+1);
  if(a&&b&&a.type===b.type&&!Array.isArray(a.type))return a;
  const branches=[a,b].filter(Boolean) as JsonSchema[];
  if(branches.length)return branches.length===1?branches[0]:{anyOf:branches};
 }
  if(ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)){
   const property=ts.isPropertyAccessExpression(node)?node.name.text:node.argumentExpression&&ts.isStringLiteralLike(node.argumentExpression)?node.argumentExpression.text:undefined;
   if(property!==undefined){
    const receiver=infer(node.expression,next,depth+1);let shape=receiver&&resolve(receiver);
    if(shape?.['x-code-to-openapi-unresolved-mutation'])return shape;
    // A nullable entity (findUnique -> anyOf[object, null]) still exposes its
    // object-branch properties when present; read them from the object branch.
    const objectBranch=(s:any):any=>{
     if(s?.type==='object')return s;
     if(Array.isArray(s?.anyOf))return s.anyOf.map(objectBranch).find((b:any)=>b?.type==='object');
     return undefined;
    };
    const obj=objectBranch(shape);
    const errorTypeText=errorParameterTypeText(ts,checker,node.expression);
    const isErrorParam=!!errorTypeText&&/(Error|Exception)/.test(errorTypeText);
    const direct=obj?.properties&&typeof obj.properties==='object'?(obj.properties as Record<string,JsonSchema>)[property]:undefined;
    // A subtype member annotated `any` yields an empty schema; fall through to the
    // built-in Error contract instead of returning an opaque empty shape.
    if(direct&&Object.keys(direct).length)return direct;
    if(shape?.type==='array'&&property==='length')return {type:'number'};
    // Error-like handler parameter (`err: Error | HttpException`): the built-in
    // Error contract fixes message/name/stack as strings and the conventional
    // HTTP status fields as integers, even when the concrete subtype annotates a
    // member as `any` (which otherwise collapses the whole union to any).
    if(isErrorParam){
      if(property==='message'||property==='name'||property==='stack'){onEvidence?.();return {type:'string'};}
      if(property==='status'||property==='statusCode'||property==='errorCode'){onEvidence?.();return {type:'integer'};}
    }
   }
  }
  if(ts.isCallExpression(node)){
   if(ts.isPropertyAccessExpression(node.expression)){
    const name=node.expression.name.text, receiver=node.expression.expression;
    // Only the native Array.map declaration establishes an array result.
    // An unrelated object's `map` method, async callback, or opaque callback
    // must not be treated as a JSON element projection. The receiver is a real
    // array when the type checker proves it, or when the value's inferred
    // schema is an array (e.g. an awaited Prisma findMany with a relation shape).
    const receiverType = checker.getTypeAtLocation(receiver);
    const receiverSchema = infer(receiver, next, depth + 1);
    const receiverIsArray =
      checker.isArrayType(receiverType) ||
      checker.isTupleType(receiverType) ||
      (!!receiverSchema && receiverSchema.type === "array");
    if(name==='map' && receiverIsArray){
     const signature=checker.getResolvedSignature(node)?.declaration;
     const callback=node.arguments[0]&&(resolveStaticValue(analysis,node.arguments[0])??node.arguments[0]);
     // The receiver is a real array when the type checker proves it (strict
     // lib.d.ts signature) OR when the value's inferred schema is an array
     // (e.g. an awaited Prisma findMany typed `any`). In the schema-proven case
     // the native declaration may be unresolvable, so the callback being a
     // local synchronous function is the only further requirement.
     const nativeMap =
       !!signature && !analysis.isProjectFile(signature.getSourceFile().fileName) &&
       /lib\.[^/\\]+\.d\.ts$/.test(signature.getSourceFile().fileName);
     const schemaProvenArray = !!receiverSchema && receiverSchema.type === "array";
     if((nativeMap||schemaProvenArray) && callback?.body && ts.isFunctionLike(callback) && !(callback.modifiers??[]).some((modifier:any)=>modifier.kind===ts.SyntaxKind.AsyncKeyword)){
      const source=receiverSchema&&receiverSchema.type==='array'?receiverSchema:fallback(receiver);const shape=source&&resolve(source);const element=shape?.items as JsonSchema|undefined;
      const saved=new Map(bindings);
      callback.parameters.forEach((param:any,index:number)=>{
       const symbol=checker.getSymbolAtLocation(param.name);
       // The map element is an input projection. Passing it to a mapper or
       // reading it is not a mutation; only an explicit write inside the
       // callback (caught by isMutable) invalidates the element type.
       if(symbol&&ts.isIdentifier(param.name))bindings.set(symbol,isMutable(param)?{'x-code-to-openapi-unresolved-mutation':true}:index===0?element??{}:index===1?{type:'integer',minimum:0}:shape??{});
      });
      try{
       const proj={type:'array',items:returns(callback,next,depth+1)??{}};
       onEvidence?.();return proj;
      }
      finally{bindings.clear();for(const [key,value] of saved)bindings.set(key,value);}
     }
    }
    // Boolean array predicates over a proven array receiver always resolve to a
    // boolean present in the response (e.g. `tags.some(t => t.id === id)`).
    if((name==='some'||name==='every')&&receiverIsArray){
      onEvidence?.();return {type:'boolean'};
    }
    const module=resolveStaticValue(analysis,receiver);
    const packageName=module&&ts.isCallExpression(module)&&module.expression.getText()==='require'?module.arguments[0]?.text:undefined;
    if(packageName==='jsonwebtoken'&&name==='sign'&&node.arguments.length>=2&&node.arguments.length<=3&&(!node.arguments[2]||ts.isObjectLiteralExpression(resolveStaticValue(analysis,node.arguments[2])??node.arguments[2]))){onEvidence?.();return {type:'string'};}
    if(packageName==='lodash'&&['omit','pick'].includes(name)){
     const object=infer(node.arguments[0],next,depth+1);const shape=object&&resolve(object);
     const keys=node.arguments.length===2&&ts.isArrayLiteralExpression(node.arguments[1])?node.arguments[1].elements:node.arguments.slice(1);
     if(shape?.properties&&keys.every((k:any)=>ts.isStringLiteralLike(k)&&!k.text.includes('.'))){
      onEvidence?.();const set=new Set(keys.map((k:any)=>k.text));
      const properties=Object.fromEntries(Object.entries(shape.properties).filter(([key])=>name==='omit'?!set.has(key):set.has(key)));
      const required=(shape.required as string[]??[]).filter(key=>key in properties);
      return {type:'object',properties,...(required.length?{required}:{})};
     }
    }
    if(ts.isIdentifier(receiver)&&receiver.text==='Object'&&name==='assign'&&!(checker.getSymbolAtLocation(receiver)?.declarations??[]).some((d:any)=>analysis.isProjectFile(d.getSourceFile().fileName))){
     const properties:Record<string,JsonSchema>={};const required=new Set<string>();let opaque=false;
     for(const arg of node.arguments){const value=infer(arg,next,depth+1);const shape=value&&resolve(value);
      if(shape?.type==='object'&&shape.properties){Object.assign(properties,shape.properties);for(const key of shape.required as string[]??[])required.add(key);}
      else opaque=true;
     }
     onEvidence?.();return {type:'object',properties,...(required.size?{required:[...required]}:{}),...(opaque?{additionalProperties:{}}:{})};
    }
   }
   const projection=prismaProjection(analysis,node);if(projection){onEvidence?.();return projection;}
   const mongoose=mongooseProjection(analysis,node);if(mongoose){onEvidence?.();return mongoose;}
   const fn=localImplementation(analysis,node);
   if(fn){
    onEvidence?.();const saved=new Map(bindings);const values=node.arguments.map((arg:any)=>infer(arg,next,depth+1));
    fn.parameters.forEach((param:any,index:number)=>{const symbol=checker.getSymbolAtLocation(param.name);if(symbol&&values[index])bindings.set(symbol,values[index]);});
    try{const actual=returns(fn,next,depth+1);if(actual)return actual;}finally{bindings.clear();for(const [key,value] of saved)bindings.set(key,value);}
   }
  }
  if(ts.isIdentifier(node)){
   const symbol=ts.isShorthandPropertyAssignment(node.parent)?checker.getShorthandAssignmentValueSymbol(node.parent):checker.getSymbolAtLocation(node);
   const decl=symbol?.valueDeclaration;
   // Callback parameter: resolve the value a host `.then`/`.map`/`.catch`
   // supplies to it, e.g. `Model.findById(id).then(data => res.send(data))`.
   if(decl&&ts.isParameter(decl)){
    const fromCallback=resolveCallbackParameter(decl,depth);
    if(fromCallback){onEvidence?.();return fromCallback;}
   }
   if(decl&&ts.isVariableDeclaration(decl)&&decl.initializer){
    if(isMutable(decl)){onEvidence?.();return {description:'Mutable or escaping value requires serialization review'};}
    if(decl.parent.flags&ts.NodeFlags.Const)return infer(decl.initializer,next,depth+1)??fallback(node);
   }
   // `const { _count, ...rest } = await db.user.update(...)`: in an object
   // binding pattern the rest element is a BindingElement carrying a
   // dotDotDotToken (RestElement is only used for array/parameter rests). The
   // rest binding carries every key the destructuring did not name. Resolve the
   // source object and drop the named keys so `{...rest}` keeps only the
   // relation/scalar fields the projection proved.
   if(decl&&ts.isBindingElement(decl)&&decl.dotDotDotToken&&decl.parent&&ts.isObjectBindingPattern(decl.parent)){
    const binding=decl.parent;
    const vd=binding.parent;
    if(vd&&ts.isVariableDeclaration(vd)&&vd.initializer){
     const omitted=new Set<string>();
     for(const el of binding.elements){
      if(el===decl)continue;
      if(ts.isBindingElement(el)&&(ts.isIdentifier(el.name)||ts.isStringLiteralLike(el.name)))omitted.add(el.name.text);
     }
     const source=infer(vd.initializer,next,depth+1);
     const shape=source&&resolve(source);
     if(shape?.type==='object'&&shape.properties){
      const properties:Record<string,JsonSchema>={};
      for(const [key,value] of Object.entries(shape.properties as Record<string,JsonSchema>)){
       if(!omitted.has(key))properties[key]=value;
      }
      const required=(shape.required as string[]??[]).filter((key)=>!omitted.has(key));
      return {type:'object',properties,...(required.length?{required}:{})};
     }
    }
   }
   // Named object destructuring `const { _count } = await db.update(...)`: the
   // binding is the named property of the source object (respecting aliases).
   if(decl&&ts.isBindingElement(decl)&&!decl.dotDotDotToken&&decl.parent&&ts.isObjectBindingPattern(decl.parent)){
    const vd=decl.parent.parent;
    if(vd&&ts.isVariableDeclaration(vd)&&vd.initializer&&(ts.isIdentifier(decl.name)||ts.isStringLiteralLike(decl.name))){
     const key=(decl.propertyName&&ts.isIdentifier(decl.propertyName)?decl.propertyName.text:decl.propertyName&&ts.isStringLiteralLike(decl.propertyName)?decl.propertyName.text:decl.name.text);
     const source=infer(vd.initializer,next,depth+1);
     const shape=source&&resolve(source);
     const obj=shape?.type==='object'?shape:Array.isArray(shape?.anyOf)?(shape!.anyOf as JsonSchema[]).find((b:any)=>b?.type==='object'):undefined;
     const prop=(obj?.properties as Record<string,JsonSchema>|undefined)?.[key];
     if(prop!==undefined)return prop;
    }
   }
  }
  if(ts.isObjectLiteralExpression(node)){
   const properties:Record<string,JsonSchema>={};const required:string[]=[];let unknownSpread=false;
   for(const prop of node.properties){
    if(ts.isSpreadAssignment(prop)){
     let spread=infer(prop.expression,next,depth+1);
     if(spread?.$ref)spread=resolve(spread);
     const branches=Array.isArray(spread?.anyOf)?spread.anyOf as JsonSchema[]:[spread];
     const objects=branches.filter((s):s is JsonSchema=>!!s&&s.type==='object');
     if(objects.length===1&&objects[0]!.properties){
      Object.assign(properties,objects[0]!.properties);
      // Merge the required set of the single resolved object branch. A `null`
      // branch (e.g. Prisma findUnique -> anyOf[object, null]) does not change
      // which object keys are required when the value is present, so it is not
      // a reason to drop them.
      required.push(...(objects[0]!.required as string[]??[]));
     }else unknownSpread=true;
     continue;
    }
    if(!ts.isPropertyAssignment(prop)&&!ts.isShorthandPropertyAssignment(prop))return fallback(node);
    const name=ts.isIdentifier(prop.name)||ts.isStringLiteralLike(prop.name)||ts.isNumericLiteral(prop.name)?prop.name.text:null;
    if(name===null)return fallback(node);
    const value=ts.isShorthandPropertyAssignment(prop)?prop.name:prop.initializer;
    const valueType=checker.getTypeAtLocation(value);
    if(valueType.flags&ts.TypeFlags.Undefined)continue;
    properties[name]=infer(value,next,depth+1)??{};
    if(!valueType.isUnion?.()||!valueType.types.some((t:any)=>t.flags&ts.TypeFlags.Undefined))required.push(name);
   }
   return {type:'object',properties,...(required.length?{required:[...new Set(required)]}:{}),...(unknownSpread?{additionalProperties:{}}:{})};
  }
  return fallback(node);
 };
 // Resolve the value a host call (`.then`/`.map`/`.catch`/...) supplies to the
 // given callback parameter by inferring the host's receiver. Walks outward
 // through nested callbacks (e.g. a `.map` inside a `.then`).
 const resolveCallbackParameter=(param:any,depth:number):JsonSchema|undefined=>{
  let host:any=param.parent;
  for(let guard=0;guard<6&&host;guard++){
   const call=host.parent;
   if(call&&ts.isCallExpression(call)&&call.arguments.includes(host)&&
      ts.isPropertyAccessExpression(call.expression)){
    const mname=call.expression.name.text;
    const idx=host.parameters?host.parameters.indexOf(param):-1;
    const receiver=call.expression.expression;
    if(mname==='then'&&idx===0){
     const s=infer(receiver,new Set(),depth+1);
     return s?resolve(s):undefined;
    }
    if(mname==='catch'&&idx===0){
     return {type:'object',properties:{message:{type:'string'},name:{type:'string'}},required:['message']};
    }
    if(['map','forEach','filter','some','every','find','findIndex','reduce'].includes(mname)&&idx===0){
     const s=infer(receiver,new Set(),depth+1);
     const sh=s?resolve(s):undefined;
     if(sh?.type==='array')return sh.items as JsonSchema;
    }
   }
   // Climb to an enclosing callback function.
   const outer=host.parent&&host.parent.parent;
   if(outer&&(ts.isArrowFunction(outer)||ts.isFunctionExpression(outer))){host=outer;continue;}
   break;
  }
  return undefined;
 };
 const returns=(fn:any,seen:Set<any>,depth:number):JsonSchema|undefined=>{
  if(!fn.body||depth>16||seen.has(fn))return undefined;
  const next=new Set(seen).add(fn);
  if(!ts.isBlock(fn.body))return infer(fn.body,next,depth+1);
  const schemas:JsonSchema[]=[];
  const visit=(n:any)=>{
   if(n!==fn.body&&ts.isFunctionLike(n))return;
   if(ts.isReturnStatement(n))schemas.push(n.expression?infer(n.expression,next,depth+1)??{}:{});
   ts.forEachChild(n,visit);
  };
  visit(fn.body);
  const unique=[...new Map(schemas.map(s=>[JSON.stringify(s),s])).values()];
  return enrich(fn,unique.length===1?unique[0]:unique.length?{anyOf:unique}:undefined);
 };
 const resolve=(schema:JsonSchema):JsonSchema=>{
  const ref=schema.$ref;
  return typeof ref==='string'&&ref.startsWith('#/components/schemas/')?analysis.schemaContext.components.get(ref.slice('#/components/schemas/'.length))??schema:schema;
 };
 const fill=(observed:JsonSchema|undefined,expected:JsonSchema|undefined,depth:number):JsonSchema|undefined=>{
  if(!expected||depth>16)return observed;
  if(!observed||!Object.keys(observed).length)return expected;
  const shape=resolve(expected);
  if(Array.isArray(observed.anyOf))return {...observed,anyOf:(observed.anyOf as JsonSchema[]).map(branch=>fill(branch,expected,depth+1)??branch)};
  if(observed.type==='array'&&shape.type==='array')return {...observed,items:fill(observed.items as JsonSchema,shape.items as JsonSchema,depth+1)};
  if(observed.type==='object'&&shape.type==='object'){
   const properties=observed.properties as Record<string,JsonSchema>|undefined;
   if(properties)return {...observed,properties:Object.fromEntries(Object.entries(properties).map(([key,value])=>[key,fill(value,(shape.properties as Record<string,JsonSchema>|undefined)?.[key],depth+1)??value]))};
  }
  return observed;
 };
 const enrich=(fn:any,actual:JsonSchema|undefined):JsonSchema|undefined=>{
  if(!fn.type)return actual;
  const type=checker.getAwaitedType(checker.getTypeFromTypeNode(fn.type));
  return fill(actual,typeToSchema(type,analysis.schemaContext),0);
 };
 return expressionMode ? infer(method,new Set(),0) : returns(method,new Set(),0);
}

/** Propagate an untyped @Query object through resolved service arguments. */
export function localObjectFields(analysis:TsAnalysis,method:any,parameter:any):string[]{
 const {ts,checker}=analysis;const fields=new Set<string>(),visited=new Set<any>();
 const walk=(fn:any,param:any,depth:number)=>{
  if(!fn.body||depth>12||visited.has(param))return;visited.add(param);
  const symbol=checker.getSymbolAtLocation(param.name);if(!symbol)return;
  const aliases=new Set([symbol]);
  const isQuery=(n:any)=>ts.isIdentifier(n)&&aliases.has(checker.getSymbolAtLocation(n));
  const visit=(n:any)=>{
   if(n!==fn.body&&ts.isFunctionLike(n))return;
   if(ts.isVariableDeclaration(n)&&n.initializer&&isQuery(n.initializer)&&(n.parent.flags&ts.NodeFlags.Const)&&ts.isIdentifier(n.name))aliases.add(checker.getSymbolAtLocation(n.name));
   // Destructuring `const { a, b } = input` (or aliased query/body bag) exposes
   // each binding name as a field of the parameter.
   if(ts.isVariableDeclaration(n)&&n.initializer&&isQuery(n.initializer)&&ts.isObjectBindingPattern(n.name)){
    for(const element of n.name.elements){
     if(ts.isBindingElement(element)&&(ts.isIdentifier(element.name)||ts.isStringLiteralLike(element.name))){
      const key=element.propertyName?element.propertyName.text:element.name.text;
      fields.add(key);
      if(ts.isIdentifier(element.name))aliases.add(checker.getSymbolAtLocation(element.name));
     }
    }
   }
   if(ts.isPropertyAccessExpression(n)&&isQuery(n.expression))fields.add(n.name.text);
   if(ts.isElementAccessExpression(n)&&isQuery(n.expression)&&ts.isStringLiteralLike(n.argumentExpression))fields.add(n.argumentExpression.text);
   if(ts.isCallExpression(n)){
    const target=localImplementation(analysis,n);
    if(target)n.arguments.forEach((arg:any,index:number)=>{if(isQuery(arg)&&target.parameters[index])walk(target,target.parameters[index],depth+1);});
   }
   ts.forEachChild(n,visit);
  };visit(fn.body);
 };
 walk(method,parameter,0);return [...fields];
}
